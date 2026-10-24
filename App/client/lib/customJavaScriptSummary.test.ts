import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeCustomJavaScript } from "./customJavaScriptSummary.js";

describe("describeCustomJavaScript", () => {
  test("says when there is none, blank lines included", () => {
    assert.equal(describeCustomJavaScript(""), "No custom JavaScript");
    assert.equal(describeCustomJavaScript("  \n\n "), "No custom JavaScript");
  });

  test("says it is on and how long it is", () => {
    assert.equal(describeCustomJavaScript("window.x = 1;"), "Custom JavaScript on · 1 line");
    assert.equal(
      describeCustomJavaScript('<script async src="https://example.com/a.js"></script>\n<script>\n  go();\n</script>\n'),
      "Custom JavaScript on · 4 lines",
    );
    assert.equal(describeCustomJavaScript("a();\r\nb();"), "Custom JavaScript on · 2 lines");
  });

  test("names unsaved changes, so a half-typed snippet is not mistaken for a saved one", () => {
    assert.equal(
      describeCustomJavaScript("", "window.x = 1;"),
      "No custom JavaScript · unsaved changes",
    );
    assert.equal(
      describeCustomJavaScript("a();", ""),
      "Custom JavaScript on · 1 line · unsaved changes",
    );
    assert.equal(describeCustomJavaScript("a();", "a();"), "Custom JavaScript on · 1 line");
  });
});
