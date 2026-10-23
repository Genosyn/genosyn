import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  canonicalRuns,
  concatRuns,
  deleteRange,
  formatAt,
  insertText,
  linkAt,
  linkifyRuns,
  looksLikeUrl,
  normalizeHref,
  normalizeRuns,
  parseInline,
  plainText,
  rangeHasMark,
  replaceRange,
  type Run,
  runsEqual,
  sameInlineContent,
  serializeInline,
  setLink,
  sliceRuns,
  splitRuns,
  toggleMark,
} from "./noteInline.js";

/** The runs with autolink style dropped: `<x>` and bare `x` are the same link. */
function semantic(runs: Run[]): Run[] {
  return normalizeRuns(
    canonicalRuns(runs).map((run) => {
      const next = { ...run };
      delete next.autolink;
      return next;
    }),
  );
}

/** Parse → serialize → parse must land on the same runs. */
function roundTrips(runs: Run[]) {
  const md = serializeInline(runs);
  assert.deepEqual(semantic(parseInline(md)), semantic(runs), `round trip through ${JSON.stringify(md)}`);
  assert.ok(sameInlineContent(parseInline(md), runs));
  return md;
}

describe("parseInline", () => {
  test("plain text is one run", () => {
    assert.deepEqual(parseInline("Hello world"), [{ text: "Hello world" }]);
  });

  test("empty source has no runs", () => {
    assert.deepEqual(parseInline(""), []);
  });

  test("bold, italic, strikethrough and code", () => {
    assert.deepEqual(parseInline("a **b** *c* _d_ ~~e~~ `f`"), [
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", italic: true },
      { text: " " },
      { text: "e", strike: true },
      { text: " " },
      { text: "f", code: true },
    ]);
  });

  test("__strong__ and nested emphasis", () => {
    assert.deepEqual(parseInline("__x__"), [{ text: "x", bold: true }]);
    assert.deepEqual(parseInline("***both***"), [{ text: "both", bold: true, italic: true }]);
    assert.deepEqual(parseInline("**a *b* c**"), [
      { text: "a ", bold: true },
      { text: "b", bold: true, italic: true },
      { text: " c", bold: true },
    ]);
  });

  test("intraword underscores stay literal; intraword stars emphasize", () => {
    assert.deepEqual(parseInline("snake_case_name"), [{ text: "snake_case_name" }]);
    assert.deepEqual(parseInline("un*frigging*believable"), [
      { text: "un" },
      { text: "frigging", italic: true },
      { text: "believable" },
    ]);
  });

  test("a lone star between spaces is literal", () => {
    assert.deepEqual(parseInline("5 * 3 = 15"), [{ text: "5 * 3 = 15" }]);
  });

  test("unclosed delimiters stay literal", () => {
    assert.deepEqual(parseInline("**not bold"), [{ text: "**not bold" }]);
    assert.deepEqual(parseInline("a `tick"), [{ text: "a `tick" }]);
  });

  test("links with titles, nested formatting and escaped parens", () => {
    assert.deepEqual(parseInline('[**Docs**](https://x.dev/a_(b) "The docs")'), [
      { text: "Docs", bold: true, href: "https://x.dev/a_(b)", title: "The docs" },
    ]);
    assert.deepEqual(parseInline("[a](<has space>)"), [{ text: "a", href: "has space" }]);
  });

  test("angle autolinks and email autolinks", () => {
    assert.deepEqual(parseInline("<https://genosyn.com>"), [
      { text: "https://genosyn.com", href: "https://genosyn.com", autolink: "angle" },
    ]);
    assert.deepEqual(parseInline("<ops@example.com>"), [
      { text: "ops@example.com", href: "mailto:ops@example.com", autolink: "angle" },
    ]);
  });

  test("bare URLs become links without trailing punctuation", () => {
    assert.deepEqual(parseInline("See https://genosyn.com/docs."), [
      { text: "See " },
      { text: "https://genosyn.com/docs", href: "https://genosyn.com/docs", autolink: "bare" },
      { text: "." },
    ]);
    assert.deepEqual(parseInline("(www.example.com)"), [
      { text: "(" },
      { text: "www.example.com", href: "http://www.example.com", autolink: "bare" },
      { text: ")" },
    ]);
  });

  test("backslash escapes and entities", () => {
    assert.deepEqual(parseInline("\\*not\\* AT&amp;T &copy; &#65; &bogus;"), [
      { text: "*not* AT&T © A &bogus;" },
    ]);
  });

  test("a backslash before a letter is literal", () => {
    assert.deepEqual(parseInline("C:\\Users"), [{ text: "C:\\Users" }]);
  });

  test("code spans strip one padding space and keep backticks", () => {
    assert.deepEqual(parseInline("`` a`b ``"), [{ text: "a`b", code: true }]);
    assert.deepEqual(parseInline("` `"), [{ text: " ", code: true }]);
  });

  test("inline HTML formatting tags become marks; other HTML stays raw", () => {
    assert.deepEqual(parseInline("foo<strong>(bar)</strong> <kbd>K</kbd>"), [
      { text: "foo" },
      { text: "(bar)", bold: true },
      { text: " " },
      { text: "<kbd>", raw: true },
      { text: "K" },
      { text: "</kbd>", raw: true },
    ]);
  });

  test("inline images are kept as raw Markdown", () => {
    assert.deepEqual(parseInline("logo ![alt](/x.png) here"), [
      { text: "logo " },
      { text: "![alt](/x.png)", raw: true },
      { text: " here" },
    ]);
  });

  test("soft and hard line breaks become newlines", () => {
    assert.deepEqual(parseInline("one  \n   two\\\nthree\nfour"), [
      { text: "one\ntwo\nthree\nfour" },
    ]);
  });
});

describe("serializeInline", () => {
  test("writes conventional delimiters", () => {
    assert.equal(
      serializeInline([
        { text: "a " },
        { text: "b", bold: true },
        { text: " " },
        { text: "c", italic: true },
        { text: " " },
        { text: "d", strike: true },
        { text: " " },
        { text: "e", code: true },
      ]),
      "a **b** *c* ~~d~~ `e`",
    );
  });

  test("moves whitespace outside of marks", () => {
    assert.equal(serializeInline([{ text: "a" }, { text: " bold ", bold: true }, { text: "b" }]), "a **bold** b");
  });

  test("escapes characters that would read as syntax", () => {
    assert.equal(serializeInline([{ text: "*not* [a] `b` _c_" }]), "\\*not\\* \\[a\\] \\`b\\` \\_c\\_");
  });

  test("leaves harmless punctuation readable", () => {
    assert.equal(serializeInline([{ text: "5 * 3, snake_case, C:\\Users, Hello!" }]), "5 * 3, snake_case, C:\\Users, Hello!");
  });

  test("escapes an entity-shaped ampersand and HTML-shaped angle bracket", () => {
    assert.equal(serializeInline([{ text: "&amp; <b>" }]), "\\&amp; \\<b>");
    assert.equal(serializeInline([{ text: "a < b & c" }]), "a < b & c");
  });

  test("falls back to HTML tags when delimiters cannot flank", () => {
    const runs: Run[] = [{ text: "foo" }, { text: "(bar)", bold: true }];
    const md = roundTrips(runs);
    assert.equal(md, "foo<strong>(bar)</strong>");
  });

  test("code spans pick a fence longer than any backtick run", () => {
    assert.equal(serializeInline([{ text: "a``b", code: true }]), "```a``b```");
    assert.equal(serializeInline([{ text: "`x", code: true }]), "`` `x ``");
  });

  test("links, titles, and links whose URL needs brackets", () => {
    assert.equal(
      serializeInline([{ text: "Docs", href: "https://x.dev", title: 'a "b"' }]),
      '[Docs](https://x.dev "a \\"b\\"")',
    );
    assert.equal(serializeInline([{ text: "a", href: "has space" }]), "[a](<has space>)");
    assert.equal(serializeInline([{ text: "a", href: "https://x.dev/(b" }]), "[a](https://x.dev/\\(b)");
  });

  test("autolinks keep their written form", () => {
    assert.equal(
      serializeInline(parseInline("Visit https://genosyn.com now")),
      "Visit https://genosyn.com now",
    );
    assert.equal(serializeInline(parseInline("<https://genosyn.com>")), "<https://genosyn.com>");
    assert.equal(serializeInline(parseInline("<ops@example.com>")), "<ops@example.com>");
  });

  test("a bare URL glued to following text is written so it stays the same link", () => {
    roundTrips([
      { text: "https://x.com", href: "https://x.com", autolink: "bare" },
      { text: "abc", bold: true },
    ]);
  });

  test("raw runs are written verbatim", () => {
    assert.equal(serializeInline([{ text: "a " }, { text: "<br>", raw: true }]), "a <br>");
  });

  test("empty runs serialize to nothing", () => {
    assert.equal(serializeInline([]), "");
    assert.equal(serializeInline([{ text: "" }]), "");
  });

  test("old editor content round-trips unchanged when re-serialized", () => {
    for (const md of [
      "Plain words",
      "**bold** and _italic_ and `code`",
      "[link](https://example.com) trailing",
    ]) {
      const runs = parseInline(md);
      const again = serializeInline(runs);
      assert.deepEqual(canonicalRuns(parseInline(again)), canonicalRuns(runs));
    }
  });
});

describe("round trips", () => {
  const cases: Run[][] = [
    [{ text: "x", bold: true, italic: true }],
    [{ text: "a", bold: true }, { text: "b", italic: true }],
    [{ text: "a", bold: true }, { text: "b", bold: true, italic: true }, { text: "c", italic: true }],
    [{ text: "a" }, { text: "b", italic: true }, { text: "c" }],
    [{ text: "(x)", italic: true }, { text: "y" }],
    [{ text: "x", strike: true, bold: true }, { text: " y", strike: true }],
    [{ text: "co`de", code: true, bold: true }],
    [{ text: "link ", href: "/a" }, { text: "bold", href: "/a", bold: true }],
    [{ text: "\\" }, { text: "x", bold: true }],
    [{ text: "a!" }, { text: "b", href: "/c" }],
    [{ text: "*" }, { text: "*", bold: true }, { text: "*" }],
    [{ text: "_" }, { text: "a", italic: true }, { text: "_" }],
    [{ text: "line one\nline two", italic: true }],
    [{ text: "ends with backslash \\" }],
    [{ text: "1. not a list" }],
  ];
  for (const runs of cases) {
    test(`round trip ${JSON.stringify(runs)}`, () => {
      roundTrips(runs);
    });
  }

  test("random runs survive a round trip", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ["a", "b", "Z", "1", " ", "*", "_", "~", "`", "[", "]", "(", ")", "!", "\\", "<", ">", "&", "#", ".", "-", "é", "\n"];
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    for (let trial = 0; trial < Number(process.env.NOTE_FUZZ_TRIALS ?? 600); trial++) {
      const runs: Run[] = [];
      const count = 1 + Math.floor(random() * 4);
      for (let r = 0; r < count; r++) {
        let text = "";
        const length = 1 + Math.floor(random() * 6);
        for (let k = 0; k < length; k++) text += pick(alphabet);
        const run: Run = { text };
        if (random() < 0.3) run.bold = true;
        if (random() < 0.3) run.italic = true;
        if (random() < 0.15) run.strike = true;
        if (random() < 0.15) run.code = true;
        if (random() < 0.15) run.href = pick(["https://a.dev", "/notes/x", "mailto:a@b.co"]);
        runs.push(run);
      }
      const md = serializeInline(runs);
      assert.deepEqual(
        semantic(parseInline(md)),
        semantic(runs),
        `trial ${trial}: ${JSON.stringify(runs)} → ${JSON.stringify(md)}`,
      );
    }
  });
});

describe("run editing", () => {
  const runs: Run[] = [{ text: "Hello " }, { text: "bold", bold: true }, { text: " world" }];

  test("plainText and slices", () => {
    assert.equal(plainText(runs), "Hello bold world");
    assert.deepEqual(sliceRuns(runs, 4, 8), [{ text: "o " }, { text: "bo", bold: true }]);
    assert.deepEqual(sliceRuns(runs, -5, 999), runs);
  });

  test("split and concat are inverses", () => {
    for (let offset = 0; offset <= plainText(runs).length; offset++) {
      const [left, right] = splitRuns(runs, offset);
      assert.equal(plainText(left).length, offset);
      assert.ok(runsEqual(concatRuns(left, right), runs));
    }
  });

  test("insertText continues the format before the caret", () => {
    assert.deepEqual(insertText(runs, 10, "!"), [
      { text: "Hello " },
      { text: "bold!", bold: true },
      { text: " world" },
    ]);
    assert.deepEqual(insertText(runs, 0, ">"), [{ text: ">Hello " }, { text: "bold", bold: true }, { text: " world" }]);
  });

  test("typing never extends a link", () => {
    const linked: Run[] = [{ text: "go", href: "/x" }];
    assert.deepEqual(formatAt(linked, 2), {});
    assert.deepEqual(insertText(linked, 2, "!"), [{ text: "go", href: "/x" }, { text: "!" }]);
  });

  test("deleteRange and replaceRange", () => {
    assert.deepEqual(deleteRange(runs, 5, 11), [{ text: "Helloworld" }]);
    assert.deepEqual(deleteRange(runs, 7, 9), [
      { text: "Hello " },
      { text: "bd", bold: true },
      { text: " world" },
    ]);
    assert.deepEqual(replaceRange(runs, 6, 10, [{ text: "fine", italic: true }]), [
      { text: "Hello " },
      { text: "fine", italic: true },
      { text: " world" },
    ]);
  });

  test("toggleMark adds over a mixed range and removes over a uniform one", () => {
    const added = toggleMark(runs, 0, 10, "bold");
    assert.deepEqual(added, [{ text: "Hello bold", bold: true }, { text: " world" }]);
    assert.ok(rangeHasMark(added, 0, 10, "bold"));
    const removed = toggleMark(added, 0, 10, "bold");
    assert.deepEqual(removed, [{ text: "Hello bold world" }]);
    assert.equal(rangeHasMark(removed, 0, 0, "bold"), false);
  });

  test("setLink links and unlinks, and linkAt finds the link", () => {
    const linked = setLink(runs, 0, 5, "https://x.dev");
    assert.deepEqual(linkAt(linked, 3), { start: 0, end: 5, href: "https://x.dev" });
    assert.equal(linkAt(linked, 8), null);
    assert.deepEqual(setLink(linked, 0, 5, null), runs);
  });

  test("normalizeHref accepts addresses people type and refuses scripts", () => {
    assert.equal(normalizeHref("https://x.dev/a?b=1"), "https://x.dev/a?b=1");
    assert.equal(normalizeHref("  genosyn.com/docs  "), "https://genosyn.com/docs");
    assert.equal(normalizeHref("localhost.test:8471/x"), "https://localhost.test:8471/x");
    assert.equal(normalizeHref("ada@example.com"), "mailto:ada@example.com");
    assert.equal(normalizeHref("/c/acme/notes"), "/c/acme/notes");
    assert.equal(normalizeHref("#section"), "#section");
    assert.equal(normalizeHref("mailto:a@b.co"), "mailto:a@b.co");
    assert.equal(normalizeHref("javascript:alert(1)"), null);
    assert.equal(normalizeHref("DATA:text/html,x"), null);
    assert.equal(normalizeHref("not a link"), null);
    assert.equal(normalizeHref(""), null);
  });

  test("looksLikeUrl spots a pasted link", () => {
    assert.equal(looksLikeUrl("https://x.dev"), true);
    assert.equal(looksLikeUrl(" mailto:a@b.co\n"), true);
    assert.equal(looksLikeUrl("see https://x.dev"), false);
    assert.equal(looksLikeUrl("x.dev"), false);
  });

  test("linkifyRuns turns typed URLs into links", () => {
    assert.deepEqual(linkifyRuns([{ text: "see https://x.dev now" }]), [
      { text: "see " },
      { text: "https://x.dev", href: "https://x.dev", autolink: "bare" },
      { text: " now" },
    ]);
  });
});
