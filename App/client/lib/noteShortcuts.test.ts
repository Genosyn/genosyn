import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyInlineShortcut, matchBlockShortcut } from "./noteShortcuts.js";
import { filterSlashCommands, SLASH_COMMANDS, slashQueryAt } from "./noteSlash.js";

describe("matchBlockShortcut", () => {
  const cases: Array<[string, string, ReturnType<typeof matchBlockShortcut>]> = [
    ["# ", "paragraph", { kind: "h1", consumed: 2, level: 1 }],
    ["## ", "paragraph", { kind: "h2", consumed: 3, level: 2 }],
    ["### ", "paragraph", { kind: "h3", consumed: 4, level: 3 }],
    ["- ", "paragraph", { kind: "bulleted", consumed: 2 }],
    ["* ", "paragraph", { kind: "bulleted", consumed: 2 }],
    ["+ ", "paragraph", { kind: "bulleted", consumed: 2 }],
    ["1. ", "paragraph", { kind: "numbered", consumed: 3, start: 1 }],
    ["7) ", "paragraph", { kind: "numbered", consumed: 3, start: 7 }],
    ["[] ", "paragraph", { kind: "todo", consumed: 3, checked: false }],
    ["[ ] ", "paragraph", { kind: "todo", consumed: 4, checked: false }],
    ["[x] ", "paragraph", { kind: "todo", consumed: 4, checked: true }],
    ["- [ ] ", "paragraph", { kind: "todo", consumed: 6, checked: false }],
    ["> ", "paragraph", { kind: "quote", consumed: 2 }],
    ['" ', "paragraph", { kind: "quote", consumed: 2 }],
    ["```", "paragraph", { kind: "code", consumed: 3, lang: "" }],
    ["```ts ", "paragraph", { kind: "code", consumed: 6, lang: "ts" }],
    ["---", "paragraph", { kind: "divider", consumed: 3 }],
    ["***", "paragraph", { kind: "divider", consumed: 3 }],
    ["[] ", "bulleted", { kind: "todo", consumed: 3, checked: false }],
    ["[x] ", "bulleted", { kind: "todo", consumed: 4, checked: true }],
  ];
  for (const [typed, type, expected] of cases) {
    test(`${JSON.stringify(typed)} in a ${type}`, () => {
      assert.deepEqual(matchBlockShortcut(typed, type), expected);
    });
  }

  test("only fires at the very start, and only on the right blocks", () => {
    assert.equal(matchBlockShortcut("a # ", "paragraph"), null);
    assert.equal(matchBlockShortcut("#### ", "paragraph"), null);
    assert.equal(matchBlockShortcut("#", "paragraph"), null);
    assert.equal(matchBlockShortcut("- ", "heading"), null);
    assert.equal(matchBlockShortcut("# ", "bulleted"), null);
    assert.equal(matchBlockShortcut("--", "paragraph"), null);
    assert.equal(matchBlockShortcut("----", "paragraph"), null);
  });
});

describe("applyInlineShortcut", () => {
  test("**bold** becomes bold and the caret lands after it", () => {
    const result = applyInlineShortcut([{ text: "a **word**" }], 10)!;
    assert.deepEqual(result.runs, [{ text: "a " }, { text: "word", bold: true }]);
    assert.equal(result.caret, 6);
    assert.equal(result.mark, "bold");
  });

  test("*italic*, _italic_, ~~strike~~, `code` and __bold__", () => {
    assert.deepEqual(applyInlineShortcut([{ text: "*it*" }], 4)!.runs, [{ text: "it", italic: true }]);
    assert.deepEqual(applyInlineShortcut([{ text: "_it_" }], 4)!.runs, [{ text: "it", italic: true }]);
    assert.deepEqual(applyInlineShortcut([{ text: "~~gone~~" }], 8)!.runs, [{ text: "gone", strike: true }]);
    assert.deepEqual(applyInlineShortcut([{ text: "run `npm ci`" }], 12)!.runs, [{ text: "run " }, { text: "npm ci", code: true }]);
    assert.deepEqual(applyInlineShortcut([{ text: "__b__" }], 5)!.runs, [{ text: "b", bold: true }]);
  });

  test("text after the caret is kept", () => {
    const result = applyInlineShortcut([{ text: "**x** tail" }], 5)!;
    assert.deepEqual(result.runs, [{ text: "x", bold: true }, { text: " tail" }]);
    assert.equal(result.caret, 1);
  });

  test("does not fire on spaces inside the delimiters, empty spans or a half-typed bold", () => {
    assert.equal(applyInlineShortcut([{ text: "** x**" }], 6), null);
    assert.equal(applyInlineShortcut([{ text: "**x **" }], 6), null);
    assert.equal(applyInlineShortcut([{ text: "****" }], 4), null);
    assert.equal(applyInlineShortcut([{ text: "**x*" }], 4), null);
    assert.equal(applyInlineShortcut([{ text: "5 * 3 *" }], 7), null);
  });

  test("underscores inside words stay literal", () => {
    assert.equal(applyInlineShortcut([{ text: "snake_case_" }], 11), null);
    assert.equal(applyInlineShortcut([{ text: "a_b_c" }], 4), null);
  });

  test("does not reach into inline code", () => {
    assert.equal(applyInlineShortcut([{ text: "*a", code: true }, { text: "b*" }], 4), null);
  });

  test("keeps formatting already around the span", () => {
    const result = applyInlineShortcut([{ text: "x *y*", bold: true }], 5)!;
    assert.deepEqual(result.runs, [{ text: "x ", bold: true }, { text: "y", bold: true, italic: true }]);
  });
});

describe("slash menu", () => {
  const ids = (q: string) => filterSlashCommands(q).map((c) => c.id);

  test("an empty query lists every block, in menu order", () => {
    assert.deepEqual(ids(""), SLASH_COMMANDS.map((c) => c.id));
  });

  test("matches labels, prefixes and keywords", () => {
    assert.equal(ids("head")[0], "h1");
    assert.equal(ids("h2")[0], "h2");
    assert.equal(ids("heading 3")[0], "h3");
    assert.equal(ids("todo")[0], "todo");
    assert.equal(ids("check")[0], "todo");
    assert.equal(ids("quote")[0], "quote");
    assert.equal(ids("hr")[0], "divider");
    assert.equal(ids("img")[0], "image");
    assert.equal(ids("sub")[0], "page");
    assert.ok(ids("list").includes("bulleted"));
    assert.ok(ids("list").includes("numbered"));
  });

  test("initials and word-anchored skips reach multi-word labels", () => {
    assert.equal(ids("bl")[0], "bulleted");
    assert.equal(ids("nl")[0], "numbered");
    assert.ok(ids("tgl").includes("toggle"));
  });

  test("Markdown shortcuts find their block", () => {
    assert.equal(ids("```")[0], "code");
    assert.equal(ids("---")[0], "divider");
  });

  test("a query matching nothing empties the menu", () => {
    assert.deepEqual(ids("zzzz"), []);
  });

  test("ignores case and accents", () => {
    assert.equal(ids("CÓDE")[0], "code");
  });
});

describe("slashQueryAt", () => {
  test("a slash at the start or after a space opens a query", () => {
    assert.deepEqual(slashQueryAt("/", 1), { start: 0, query: "" });
    assert.deepEqual(slashQueryAt("/head", 5), { start: 0, query: "head" });
    assert.deepEqual(slashQueryAt("Some text /to", 13), { start: 10, query: "to" });
    assert.deepEqual(slashQueryAt("/heading 2", 10), { start: 0, query: "heading 2" });
  });

  test("a slash inside a word, a URL or a date is just a slash", () => {
    assert.equal(slashQueryAt("and/or", 6), null);
    assert.equal(slashQueryAt("https://x", 9), null);
    assert.equal(slashQueryAt("10/23", 5), null);
  });

  test("the query ends at a double space, a line break or a long run", () => {
    assert.equal(slashQueryAt("/head  ", 7), null);
    assert.equal(slashQueryAt("/head\nx", 7), null);
    assert.equal(slashQueryAt(`/${"x".repeat(30)}`, 31), null);
    assert.equal(slashQueryAt("/ space", 7), null);
  });

  test("text after the caret doesn't matter", () => {
    assert.deepEqual(slashQueryAt("/h1 rest", 3), { start: 0, query: "h1" });
  });
});
