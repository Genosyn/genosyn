import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canonicalRuns, normalizeRuns, plainText, type Run } from "./noteInline.js";
import {
  type Block,
  blocksToMarkdown,
  isUnchanged,
  listOrdinals,
  newBlockId,
  type NoteDoc,
  parseDoc,
  serializeDoc,
} from "./noteMarkdown.js";

/** A block's shape without ids or origins, for comparing structure. */
function shape(block: Block) {
  const out: Record<string, unknown> = { type: block.type, depth: block.depth };
  if (block.runs.length) out.text = plainText(block.runs);
  if (block.text) out.source = block.text;
  for (const key of ["level", "checked", "start", "lang", "kind", "src", "alt", "title"] as const) {
    if (block[key] !== undefined && block[key] !== "") out[key] = block[key];
  }
  return out;
}

function shapes(md: string) {
  return parseDoc(md).blocks.map(shape);
}

function block(type: Block["type"], extra: Partial<Block> = {}): Block {
  return { id: newBlockId(), type, depth: 0, runs: [], text: "", ...extra };
}

function runsOf(text: string): Run[] {
  return text ? [{ text }] : [];
}

function edit(doc: NoteDoc, index: number, patch: Partial<Block>): NoteDoc {
  const blocks = doc.blocks.slice();
  blocks[index] = { ...blocks[index], ...patch };
  return { ...doc, blocks };
}

/** Documents a person or an AI Employee plausibly writes. Each must survive untouched. */
const CORPUS: Record<string, string> = {
  empty: "",
  whitespace: "\n\n  \n",
  plain: "Hello world",
  trailingNewline: "Hello world\n",
  oldEditor: "# Title\n\nIntro paragraph with **bold** and _italic_.\n\n- one\n- two\n- [x] done\n- [ ] open\n\n1. first\n1. second\n\n> quoted\n\n---\n\nEnd.",
  crlf: "# Title\r\n\r\nLine one\r\nLine two\r\n\r\n- a\r\n- b\r\n",
  headings: "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n#No space\n## Closing ##",
  nestedLists:
    "- parent\n  - child\n    - grandchild\n  - child two\n- second\n\n1. one\n   1. nested ordered\n   2. again\n2. two\n10. ten\n    - deep",
  looseList: "- a\n\n- b\n\n  continuation paragraph\n\n- c",
  starBullets: "* star\n+ plus\n-   wide marker\n-\ttab marker",
  tasks: "- [ ] todo\n- [x] done\n- [X] done upper\n  - [ ] nested todo",
  code: "```ts\nconst a = 1;\n\nfunction b() {}\n```\n\n~~~\ntildes\n~~~\n\n````md\n```inner```\n````",
  unclosedFence: "text\n\n```js\nno end",
  indentedCode: "para\n\n    indented code\n    more\n\nafter",
  tables:
    "| Name | Role |\n| --- | :---: |\n| Ada | Analyst |\n| Bo | Ops |\n\nText after\n\na | b\n--|--\n1 | 2",
  html: "<div align=\"center\">\n  <img src=\"x.png\">\n</div>\n\n<!-- a comment\nspanning -->\n\n<br>",
  details:
    "<details>\n<summary>Click to expand</summary>\n\nHidden **content**\n\n- item\n\n</details>\n\n<details open><summary>Inline summary</summary>\n\nBody\n\n</details>",
  nestedDetails:
    "<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ndeep\n\n</details>\n\n</details>",
  detailsWithCode: "<details>\n<summary>Code</summary>\n\n```html\n</details>\n```\n\n</details>",
  brokenDetails: "<details>\nno summary here\n</details>",
  callouts:
    "> [!NOTE]\n> Useful information.\n\n> [!WARNING]\n> Line one\n> Line two\n\n> [!TIP]\n\n> plain quote\n> continues\n>\n> second paragraph",
  complexQuote: "> # heading in quote\n> - list in quote\n\n> lazy\ncontinuation",
  setext: "Title\n=====\n\nSubtitle\n--------",
  images: "![Logo](https://x.dev/logo.png)\n\n![alt with \\] bracket](<path with space.png> \"Title\")\n\ntext ![inline](i.png) image",
  references: "See [the docs][docs].\n\n[docs]: https://example.com\n\nFootnote[^1].\n\n[^1]: The note.\n    continued",
  emphasisVariants: "__strong__ *em* ***both*** ~~strike~~ ~single~ <b>html</b> `code` \\*escaped\\*",
  links: "[text](https://x.dev \"title\") <https://auto.dev> https://bare.dev www.www.dev mail <a@b.co>",
  hardBreaks: "line one  \nline two\\\nline three",
  trailingSpaces: "spaces after   \n\nnext   ",
  tabsAndSpaces: "\tTabbed paragraph\n\n  - indented bullet\n\n   1. three-space ordered",
  hrVariants: "***\n\n___\n\n- - -\n\n*  *  *",
  emoji: "# 🚀 Launch plan\n\n- ✅ Ship it\n- 🧪 Test it\n\nCafé naïve — “quotes” …",
  mixedAiOutput:
    "## Summary\n\nThe Q3 numbers came in **above plan**:\n\n| Metric | Q2 | Q3 |\n|--------|----|----|\n| ARR | $1.2M | $1.5M |\n\n### Next steps\n\n1. Hire two engineers\n2. Ship the *new* onboarding\n   - Owner: Ada\n   - Due: **Nov 1**\n3. Review pricing\n\n```bash\nnpm run deploy -- --env prod\n```\n\n> [!IMPORTANT]\n> Budget approval needed before Nov 15.\n\n<details>\n<summary>Raw data</summary>\n\n```json\n{\"arr\": 1500000}\n```\n\n</details>\n",
  leadingBlankLines: "\n\n# Starts late",
  manyBlankLines: "a\n\n\n\nb\n\n\n",
  lazyContinuation: "- item one\ncontinued lazily\n- item two",
  orderedStarts: "3. three\n4. four\n\nbreak\n\n1) paren style\n2) again",
  emptyItems: "-\n- \n1.\n- [ ]",
  numberedDot: "2023. A year paragraph",
};

describe("lossless round trip", () => {
  for (const [name, md] of Object.entries(CORPUS)) {
    test(`unchanged "${name}" is written back byte-for-byte`, () => {
      const doc = parseDoc(md);
      assert.equal(serializeDoc(doc), md);
      assert.ok(doc.blocks.every((b, i) => isUnchanged(b, listOrdinals(doc.blocks)[i])));
    });
  }

  test("every substring of the corpus round-trips too", () => {
    const all = Object.values(CORPUS).join("\n\n");
    for (let start = 0; start < all.length; start += 37) {
      for (const length of [5, 40, 160]) {
        const md = all.slice(start, start + length);
        assert.equal(serializeDoc(parseDoc(md)), md, JSON.stringify(md));
      }
    }
  });
});

describe("parsing", () => {
  test("headings carry their level", () => {
    assert.deepEqual(shapes("# A\n### C\n###### F"), [
      { type: "heading", depth: 0, text: "A", level: 1 },
      { type: "heading", depth: 0, text: "C", level: 3 },
      { type: "heading", depth: 0, text: "F", level: 6 },
    ]);
  });

  test("`#word` without a space is a paragraph", () => {
    assert.deepEqual(shapes("#hashtag"), [{ type: "paragraph", depth: 0, text: "#hashtag" }]);
  });

  test("nested lists become depths", () => {
    assert.deepEqual(shapes(CORPUS.nestedLists), [
      { type: "bulleted", depth: 0, text: "parent" },
      { type: "bulleted", depth: 1, text: "child" },
      { type: "bulleted", depth: 2, text: "grandchild" },
      { type: "bulleted", depth: 1, text: "child two" },
      { type: "bulleted", depth: 0, text: "second" },
      { type: "numbered", depth: 0, text: "one", start: 1 },
      { type: "numbered", depth: 1, text: "nested ordered", start: 1 },
      { type: "numbered", depth: 1, text: "again" },
      { type: "numbered", depth: 0, text: "two" },
      { type: "numbered", depth: 0, text: "ten" },
      { type: "bulleted", depth: 1, text: "deep" },
    ]);
  });

  test("a loose list item keeps its child paragraph", () => {
    assert.deepEqual(shapes(CORPUS.looseList), [
      { type: "bulleted", depth: 0, text: "a" },
      { type: "bulleted", depth: 0, text: "b" },
      { type: "paragraph", depth: 1, text: "continuation paragraph" },
      { type: "bulleted", depth: 0, text: "c" },
    ]);
  });

  test("tasks become to-dos with their checked state", () => {
    assert.deepEqual(shapes(CORPUS.tasks), [
      { type: "todo", depth: 0, text: "todo", checked: false },
      { type: "todo", depth: 0, text: "done", checked: true },
      { type: "todo", depth: 0, text: "done upper", checked: true },
      { type: "todo", depth: 1, text: "nested todo", checked: false },
    ]);
  });

  test("fenced code keeps language and blank lines", () => {
    const [first, second, third] = parseDoc(CORPUS.code).blocks;
    assert.equal(first.type, "code");
    assert.equal(first.lang, "ts");
    assert.equal(first.text, "const a = 1;\n\nfunction b() {}");
    assert.equal(second.text, "tildes");
    assert.equal(third.text, "```inner```");
    assert.equal(third.lang, "md");
  });

  test("the old editor's code-fence data loss is gone: code stays code", () => {
    const doc = parseDoc("```\nline 1\nline 2\n```");
    assert.deepEqual(doc.blocks.map(shape), [{ type: "code", depth: 0, source: "line 1\nline 2" }]);
  });

  test("tables are kept as table source", () => {
    const blocks = parseDoc(CORPUS.tables).blocks;
    assert.equal(blocks[0].type, "table");
    assert.equal(blocks[0].text, "| Name | Role |\n| --- | :---: |\n| Ada | Analyst |\n| Bo | Ops |");
    assert.equal(blocks[1].type, "paragraph");
    assert.equal(blocks[2].type, "table");
  });

  test("toggles nest their children and read the open attribute", () => {
    const blocks = parseDoc(CORPUS.details).blocks;
    assert.deepEqual(blocks.map(shape), [
      { type: "toggle", depth: 0, text: "Click to expand" },
      { type: "paragraph", depth: 1, text: "Hidden content" },
      { type: "bulleted", depth: 1, text: "item" },
      { type: "toggle", depth: 0, text: "Inline summary" },
      { type: "paragraph", depth: 1, text: "Body" },
    ]);
    assert.equal(blocks[0].open, false);
    assert.equal(blocks[3].open, true);
  });

  test("nested toggles and a `</details>` inside code", () => {
    assert.deepEqual(shapes(CORPUS.nestedDetails), [
      { type: "toggle", depth: 0, text: "Outer" },
      { type: "toggle", depth: 1, text: "Inner" },
      { type: "paragraph", depth: 2, text: "deep" },
    ]);
    assert.deepEqual(shapes(CORPUS.detailsWithCode), [
      { type: "toggle", depth: 0, text: "Code" },
      { type: "code", depth: 1, source: "</details>", lang: "html" },
    ]);
  });

  test("a details block without a summary stays raw", () => {
    assert.deepEqual(shapes(CORPUS.brokenDetails).map((b) => b.type), ["raw"]);
  });

  test("GitHub alerts become callouts; plain quotes stay quotes", () => {
    assert.deepEqual(shapes(CORPUS.callouts), [
      { type: "callout", depth: 0, text: "Useful information.", kind: "note" },
      { type: "callout", depth: 0, text: "Line one\nLine two", kind: "warning" },
      { type: "callout", depth: 0, kind: "tip" },
      { type: "quote", depth: 0, text: "plain quote\ncontinues\n\nsecond paragraph" },
    ]);
  });

  test("quotes holding block syntax are kept as source", () => {
    assert.equal(parseDoc(CORPUS.complexQuote).blocks[0].type, "raw");
  });

  test("setext headings and HTML are kept as source", () => {
    assert.deepEqual(shapes(CORPUS.setext).map((b) => b.type), ["raw", "raw"]);
    assert.deepEqual(shapes(CORPUS.html).map((b) => b.type), ["raw", "raw", "raw"]);
  });

  test("a lone image line is an image block", () => {
    const blocks = parseDoc(CORPUS.images).blocks;
    assert.deepEqual(blocks.map(shape), [
      { type: "image", depth: 0, src: "https://x.dev/logo.png", alt: "Logo" },
      { type: "image", depth: 0, src: "path with space.png", alt: "alt with ] bracket", title: "Title" },
      { type: "paragraph", depth: 0, text: "text ![inline](i.png) image" },
    ]);
  });

  test("numbered lists remember their first number only", () => {
    const blocks = parseDoc(CORPUS.orderedStarts).blocks;
    assert.equal(blocks[0].start, 3);
    assert.equal(blocks[1].start, undefined);
    assert.deepEqual(listOrdinals(blocks).filter((n) => n !== undefined), [3, 4, 1, 2]);
  });

  test("lazy continuation joins the item's text", () => {
    assert.deepEqual(shapes(CORPUS.lazyContinuation), [
      { type: "bulleted", depth: 0, text: "item one\ncontinued lazily" },
      { type: "bulleted", depth: 0, text: "item two" },
    ]);
  });

  test("a year followed by a dot is still a list item, as CommonMark reads it", () => {
    assert.deepEqual(shapes("2023. A year"), [{ type: "numbered", depth: 0, text: "A year", start: 2023 }]);
  });
});

describe("editing writes only what changed", () => {
  test("editing one block leaves the rest of an AI-written note untouched", () => {
    const md = CORPUS.mixedAiOutput;
    const doc = parseDoc(md);
    const index = doc.blocks.findIndex((b) => b.type === "heading" && plainText(b.runs) === "Next steps");
    const next = edit(doc, index, { runs: runsOf("Next steps (revised)") });
    const out = serializeDoc(next);
    assert.equal(out, md.replace("### Next steps", "### Next steps (revised)"));
  });

  test("checking a to-do rewrites just that line", () => {
    const md = "- [ ] one\n- [ ] two\n- [ ] three";
    const doc = parseDoc(md);
    assert.equal(serializeDoc(edit(doc, 1, { checked: true })), "- [ ] one\n- [x] two\n- [ ] three");
  });

  test("unchanged neighbours keep their exotic formatting", () => {
    const md = "*   star item\n*   another\n\nPara  with  double  spaces";
    const doc = parseDoc(md);
    const out = serializeDoc(edit(doc, 2, { runs: runsOf("New paragraph") }));
    assert.equal(out, "*   star item\n*   another\n\nNew paragraph");
  });

  test("a heading turned into a paragraph gets the blank line it now needs", () => {
    const doc = parseDoc("# Title\nText under it");
    const out = serializeDoc(edit(doc, 0, { type: "paragraph", level: undefined }));
    assert.equal(out, "Title\n\nText under it");
    assert.equal(parseDoc(out).blocks.length, 2);
  });

  test("inserting a numbered item renumbers the items after it", () => {
    const doc = parseDoc("1. a\n2. b\n3. c");
    const blocks = doc.blocks.slice();
    blocks.splice(1, 0, block("numbered", { runs: runsOf("new") }));
    assert.equal(serializeDoc({ ...doc, blocks }), "1. a\n2. new\n3. b\n4. c");
  });

  test("re-indenting a child under a re-written parent keeps it nested", () => {
    const doc = parseDoc("1. parent\n   - child");
    const out = serializeDoc(edit(doc, 0, { type: "bulleted", start: undefined }));
    assert.equal(out, "- parent\n  - child");
    assert.deepEqual(parseDoc(out).blocks.map((b) => b.depth), [0, 1]);
  });

  test("moving an unchanged block keeps its own lines", () => {
    const doc = parseDoc("Alpha  **x**\n\nBeta");
    const out = serializeDoc({ ...doc, blocks: [doc.blocks[1], doc.blocks[0]] });
    assert.equal(out, "Beta\n\nAlpha  **x**");
  });

  test("deleting the last block drops the source's trailing newline", () => {
    const doc = parseDoc("one\n\ntwo\n");
    assert.equal(serializeDoc({ ...doc, blocks: [doc.blocks[0]] }), "one");
  });

  test("an emptied page saves as empty", () => {
    const doc = parseDoc("Some text");
    assert.equal(serializeDoc({ ...doc, blocks: [block("paragraph")] }), "");
  });

  test("a new page made of new blocks", () => {
    const doc: NoteDoc = {
      blocks: [
        block("heading", { level: 1, runs: runsOf("Plan") }),
        block("paragraph", { runs: [{ text: "Ship " }, { text: "fast", bold: true }] }),
        block("bulleted", { runs: runsOf("one") }),
        block("bulleted", { runs: runsOf("child"), depth: 1 }),
        block("todo", { runs: runsOf("task"), checked: true }),
        block("numbered", { runs: runsOf("first") }),
        block("numbered", { runs: runsOf("second") }),
        block("quote", { runs: runsOf("Wise words") }),
        block("callout", { kind: "warning", runs: runsOf("Careful") }),
        block("toggle", { runs: runsOf("More") }),
        block("paragraph", { depth: 1, runs: runsOf("Hidden") }),
        block("code", { lang: "py", text: "print(1)" }),
        block("divider"),
        block("image", { src: "https://x.dev/a.png", alt: "A" }),
      ],
      leading: "",
      trailing: "",
      segments: 0,
    };
    assert.equal(
      serializeDoc(doc),
      [
        "# Plan",
        "",
        "Ship **fast**",
        "",
        "- one",
        "  - child",
        "- [x] task",
        "",
        "1. first",
        "2. second",
        "",
        "> Wise words",
        "",
        "> [!WARNING]",
        "> Careful",
        "",
        "<details>",
        "<summary>More</summary>",
        "",
        "Hidden",
        "",
        "</details>",
        "",
        "```py",
        "print(1)",
        "```",
        "",
        "---",
        "",
        "![A](https://x.dev/a.png)",
      ].join("\n"),
    );
  });

  test("text that looks like block syntax is escaped", () => {
    const tricky = [
      "# not a heading",
      "- not a list",
      "1. not numbered",
      "> not a quote",
      "---",
      "```",
      "<div>",
      "[x]: not a definition",
      "| a | b |\n| --- | --- |",
    ];
    for (const text of tricky) {
      const doc: NoteDoc = { blocks: [block("paragraph", { runs: runsOf(text) })], leading: "", trailing: "", segments: 0 };
      const back = parseDoc(serializeDoc(doc)).blocks;
      assert.equal(back.length, 1, `${JSON.stringify(text)} → ${JSON.stringify(serializeDoc(doc))}`);
      assert.equal(back[0].type, "paragraph");
      assert.equal(plainText(back[0].runs), text.replace(/\n/, "\n"));
    }
  });

  test("a heading ending in hashes keeps them", () => {
    const doc: NoteDoc = { blocks: [block("heading", { level: 2, runs: runsOf("C#") })], leading: "", trailing: "", segments: 0 };
    const md = serializeDoc(doc);
    assert.equal(plainText(parseDoc(md).blocks[0].runs), "C#");
  });

  test("code containing fences gets a longer fence", () => {
    const doc: NoteDoc = { blocks: [block("code", { text: "```\ninner\n```" })], leading: "", trailing: "", segments: 0 };
    const md = serializeDoc(doc);
    assert.equal(md, "````\n```\ninner\n```\n````");
    assert.equal(parseDoc(md).blocks[0].text, "```\ninner\n```");
  });

  test("blocksToMarkdown copies a selection without its source formatting", () => {
    const doc = parseDoc("*  a\n   *  b");
    assert.equal(blocksToMarkdown(doc.blocks.slice(1)), "- b");
    assert.equal(blocksToMarkdown(doc.blocks), "- a\n  - b");
  });
});

// ───────────────────────── Random documents ─────────────────────────────────

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const TEXT_PIECES = [
  "word",
  "Ada",
  " ",
  "  ",
  "*",
  "_",
  "`",
  "~",
  "#",
  "# ",
  "- ",
  "1. ",
  "> ",
  "[",
  "]",
  "(",
  ")",
  "!",
  "<",
  "<div>",
  "&amp;",
  "\\",
  "|",
  "---",
  "\n",
  "é",
  "🚀",
  "https://x.dev",
];

/** What survives being written: whitespace around line breaks, blank lines inside text. */
function settle(runs: readonly Run[], keepBlankLines: boolean): Run[] {
  const canon = canonicalRuns(runs);
  const out: Run[] = [];
  for (const run of canon) {
    const copy = { ...run };
    delete copy.autolink;
    out.push(copy);
  }
  let text = plainText(out);
  // Trim leading/trailing whitespace and line breaks the way block writing does.
  const flat: Array<{ ch: string; run: Run }> = [];
  for (const run of out) for (const ch of Array.from(run.text)) flat.push({ ch, run });
  const kept = flat.filter((c, i, all) => {
    if (c.ch !== "\n" || c.run.code || c.run.raw) return true;
    if (keepBlankLines) return true;
    return all[i - 1]?.ch !== "\n";
  });
  while (kept.length && /\s/.test(kept[0].ch) && !kept[0].run.code && !kept[0].run.raw) kept.shift();
  while (kept.length && /\s/.test(kept[kept.length - 1].ch) && !kept[kept.length - 1].run.code && !kept[kept.length - 1].run.raw) kept.pop();
  text = kept.map((c) => c.ch).join("");
  void text;
  return normalizeRuns(kept.map((c) => ({ ...c.run, text: c.ch })));
}

function randomRuns(random: () => number, allowNewlines: boolean): Run[] {
  const runs: Run[] = [];
  const count = 1 + Math.floor(random() * 3);
  for (let r = 0; r < count; r++) {
    let text = "";
    const pieces = 1 + Math.floor(random() * 4);
    for (let k = 0; k < pieces; k++) {
      const piece = TEXT_PIECES[Math.floor(random() * TEXT_PIECES.length)];
      if (piece === "\n" && !allowNewlines) continue;
      text += piece;
    }
    const run: Run = { text };
    if (random() < 0.25) run.bold = true;
    if (random() < 0.2) run.italic = true;
    if (random() < 0.1) run.strike = true;
    if (random() < 0.1) run.code = true;
    if (random() < 0.1) run.href = "https://a.dev/x";
    runs.push(run);
  }
  return normalizeRuns(runs);
}

function randomDoc(random: () => number): Block[] {
  const blocks: Block[] = [];
  const count = 1 + Math.floor(random() * 10);
  for (let i = 0; i < count; i++) {
    const prev = blocks[blocks.length - 1];
    const maxDepth = prev ? (["bulleted", "numbered", "todo", "toggle"].includes(prev.type) ? prev.depth + 1 : prev.depth) : 0;
    const depth = Math.floor(random() * (maxDepth + 1));
    const roll = random();
    let next: Block;
    if (roll < 0.2) next = block("paragraph", { runs: randomRuns(random, true) });
    else if (roll < 0.3) next = block("heading", { level: 1 + Math.floor(random() * 6), runs: randomRuns(random, false) });
    else if (roll < 0.42) next = block("bulleted", { runs: randomRuns(random, true) });
    else if (roll < 0.52) next = block("numbered", { runs: randomRuns(random, true) });
    else if (roll < 0.6) next = block("todo", { checked: random() < 0.5, runs: randomRuns(random, true) });
    else if (roll < 0.66) next = block("toggle", { runs: randomRuns(random, false) });
    else if (roll < 0.72) next = block("quote", { runs: randomRuns(random, true) });
    else if (roll < 0.77) next = block("callout", { kind: "tip", runs: randomRuns(random, true) });
    else if (roll < 0.83) next = block("code", { lang: random() < 0.5 ? "js" : "", text: ["x = 1", "```", "", "  y"].slice(0, 1 + Math.floor(random() * 4)).join("\n") });
    else if (roll < 0.87) next = block("divider");
    else if (roll < 0.91) next = block("image", { src: random() < 0.5 ? "https://x.dev/a.png" : "a b.png", alt: "Alt [x]" });
    else if (roll < 0.95) next = block("table", { text: "| a | b |\n| --- | --- |\n| 1 | 2 |" });
    else next = block("raw", { text: "<div>\nraw html\n</div>" });
    next.depth = depth;
    blocks.push(next);
  }
  return blocks;
}

/** What a block becomes after being written and read back. */
function expected(block: Block) {
  const out: Record<string, unknown> = { type: block.type, depth: block.depth };
  if (["paragraph", "bulleted", "numbered", "todo"].includes(block.type)) {
    out.runs = settle(block.runs, false);
  } else if (block.type === "heading" || block.type === "toggle") {
    out.runs = settle(block.runs.map((r) => ({ ...r, text: r.code ? r.text : r.text.replace(/\n/g, " ") })), false);
  } else if (block.type === "quote" || block.type === "callout") {
    out.runs = settle(block.runs, true);
  }
  for (const key of ["level", "checked", "lang", "kind", "src", "alt"] as const) {
    if (block[key] !== undefined) out[key] = block[key];
  }
  if (block.type === "code" || block.type === "table" || block.type === "raw") out.text = block.text;
  return out;
}

function actual(block: Block) {
  const out = expected({ ...block, runs: block.runs });
  if ("runs" in out) out.runs = settle(block.runs, true);
  return out;
}

describe("random documents", () => {
  test("new blocks written and read back keep their structure and text", () => {
    const random = lcg(4242);
    const trials = Number(process.env.NOTE_FUZZ_TRIALS ?? 400);
    for (let trial = 0; trial < trials; trial++) {
      const blocks = randomDoc(random);
      const doc: NoteDoc = { blocks, leading: "", trailing: "", segments: 0 };
      const md = serializeDoc(doc);
      const wanted = blocks
        .filter((b) => !(b.type === "paragraph" && settle(b.runs, false).length === 0))
        .map(expected);
      const back = parseDoc(md).blocks.map(actual);
      assert.deepEqual(back, wanted, `trial ${trial}\n${md}`);
      // And what was read back is written back byte-for-byte.
      assert.equal(serializeDoc(parseDoc(md)), md);
    }
  });
});
