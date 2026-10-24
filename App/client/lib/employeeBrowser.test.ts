import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { allowedHostPatterns, browserAdvancedSummary } from "./employeeBrowser.js";

describe("reading an employee's allowed websites", () => {
  test("one pattern per line, trimmed, in order", () => {
    assert.deepEqual(allowedHostPatterns("  mail.google.com \n*.github.com"), [
      "mail.google.com",
      "*.github.com",
    ]);
  });

  test("comments and blank lines are not websites", () => {
    assert.deepEqual(
      allowedHostPatterns("# Examples:\n\nmail.google.com\n   # a note\r\n*.github.com\n\n"),
      ["mail.google.com", "*.github.com"],
    );
  });

  test("nothing written means no restriction", () => {
    assert.deepEqual(allowedHostPatterns(""), []);
    assert.deepEqual(allowedHostPatterns(null), []);
    assert.deepEqual(allowedHostPatterns(undefined), []);
    assert.deepEqual(allowedHostPatterns("# only a note"), []);
  });
});

describe("the Browser page's closed Advanced line", () => {
  test("says where it may browse and whether it asks first — both, always", () => {
    assert.equal(browserAdvancedSummary("", false), "Any website · Submits forms without asking");
    assert.equal(
      browserAdvancedSummary("mail.google.com", true),
      "1 allowed website · Asks before submitting forms",
    );
    assert.equal(
      browserAdvancedSummary("# work\nmail.google.com\n*.github.com\nnotion.so", true),
      "3 allowed websites · Asks before submitting forms",
    );
  });

  test("a list of only comments still allows any website", () => {
    assert.equal(
      browserAdvancedSummary("# nothing yet", true),
      "Any website · Asks before submitting forms",
    );
  });
});
