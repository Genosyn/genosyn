import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { plainText } from "./noteInline.js";
import type { Block } from "./noteMarkdown.js";
import {
  blocksFromClipboard,
  htmlHasStructure,
  htmlToBlocks,
  looksLikeMarkdown,
  parseHtmlFragment,
  textToBlocks,
} from "./notePaste.js";

function sketch(blocks: readonly Block[]): string[] {
  return blocks.map((x) => {
    const text = x.type === "code" || x.type === "table" || x.type === "raw" ? x.text : x.type === "image" ? `${x.alt}@${x.src}` : plainText(x.runs);
    const extra = x.type === "todo" ? `[${x.checked ? "x" : " "}]` : x.type === "heading" ? `h${x.level}` : x.type === "code" && x.lang ? `(${x.lang})` : "";
    return `${x.type}${extra}:${x.depth}:${text}`;
  });
}

const html = (source: string) => htmlToBlocks(parseHtmlFragment(source));

describe("parseHtmlFragment", () => {
  test("builds a tree, decoding entities and dropping comments", () => {
    const root = parseHtmlFragment('<!-- x --><p class="a">Tom &amp; Jerry</p><br/>');
    assert.equal(root.type, "element");
    if (root.type !== "element") return;
    assert.equal(root.children.length, 2);
    const p = root.children[0];
    assert.equal(p.type === "element" && p.tag, "p");
    assert.deepEqual(p.type === "element" && p.children, [{ type: "text", text: "Tom & Jerry" }]);
  });

  test("closes paragraphs and list items left open", () => {
    const root = parseHtmlFragment("<ul><li>one<li>two</ul><p>a<p>b");
    if (root.type !== "element") throw new Error("root");
    const ul = root.children[0];
    if (ul.type !== "element") throw new Error("ul");
    assert.equal(ul.children.length, 2);
    assert.equal(root.children.filter((c) => c.type === "element" && c.tag === "p").length, 2);
  });

  test("keeps script and style contents out of the text", () => {
    assert.deepEqual(sketch(html("<style>p{color:red}</style><script>alert(1)</script><p>ok</p>")), ["paragraph:0:ok"]);
  });
});

describe("htmlToBlocks", () => {
  test("headings, paragraphs and inline formatting", () => {
    const blocks = html("<h1>Title</h1><p>Some <strong>bold</strong>, <em>italic</em>, <s>gone</s> and <code>code</code>.</p><h4>Small</h4>");
    assert.deepEqual(sketch(blocks), ["headingh1:0:Title", "paragraph:0:Some bold, italic, gone and code.", "headingh4:0:Small"]);
    assert.deepEqual(blocks[1].runs, [
      { text: "Some " },
      { text: "bold", bold: true },
      { text: ", " },
      { text: "italic", italic: true },
      { text: ", " },
      { text: "gone", strike: true },
      { text: " and " },
      { text: "code", code: true },
      { text: "." },
    ]);
  });

  test("links keep their target; script links are dropped", () => {
    const blocks = html('<p><a href="https://x.dev">site</a> <a href="javascript:alert(1)">bad</a></p>');
    assert.deepEqual(blocks[0].runs, [{ text: "site", href: "https://x.dev" }, { text: " bad" }]);
  });

  test("nested lists become nested blocks", () => {
    const blocks = html("<ul><li>one<ul><li>one.a</li></ul></li><li>two</li></ul><ol start=\"3\"><li>three</li><li>four</li></ol>");
    assert.deepEqual(sketch(blocks), ["bulleted:0:one", "bulleted:1:one.a", "bulleted:0:two", "numbered:0:three", "numbered:0:four"]);
    assert.equal(blocks[3].start, 3);
  });

  test("list items wrapped in paragraphs (Google Docs) read as items", () => {
    const blocks = html('<ul><li><p dir="ltr"><span>Docs item</span></p></li></ul>');
    assert.deepEqual(sketch(blocks), ["bulleted:0:Docs item"]);
  });

  test("checkbox list items become to-dos", () => {
    const blocks = html('<ul><li><input type="checkbox" checked> Shipped</li><li><input type="checkbox"> Pending</li><li role="checkbox" aria-checked="true">Docs check</li></ul>');
    assert.deepEqual(sketch(blocks), ["todo[x]:0:Shipped", "todo[ ]:0:Pending", "todo[x]:0:Docs check"]);
  });

  test("quotes, code with language, rules and images", () => {
    const blocks = html('<blockquote><p>Wise</p><p>words</p></blockquote><pre><code class="language-ts">const a = 1;\n  indented</code></pre><hr><img src="https://x.dev/a.png" alt="A">');
    assert.deepEqual(sketch(blocks), ["quote:0:Wise\n\nwords", "code(ts):0:const a = 1;\n  indented", "divider:0:", "image:0:A@https://x.dev/a.png"]);
  });

  test("inline data: images are dropped rather than bloating the note", () => {
    assert.deepEqual(sketch(html('<p>x</p><img src="data:image/png;base64,AAAA">')), ["paragraph:0:x"]);
  });

  test("tables become Markdown tables", () => {
    const blocks = html("<table><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody><tr><td>Ada</td><td>A | B</td></tr></tbody></table>");
    assert.deepEqual(sketch(blocks), ["table:0:| Name | Role |\n| --- | --- |\n| Ada | A \\| B |"]);
  });

  test("Google Docs' bold wrapper with normal weight is not bold", () => {
    const blocks = html('<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">Bold</span><span> plain</span></p></b>');
    assert.deepEqual(blocks[0].runs, [{ text: "Bold", bold: true }, { text: " plain" }]);
  });

  test("styled spans carry italic and strikethrough", () => {
    const blocks = html('<p><span style="font-style:italic">it</span> <span style="text-decoration:line-through">st</span></p>');
    assert.deepEqual(blocks[0].runs, [{ text: "it", italic: true }, { text: " " }, { text: "st", strike: true }]);
  });

  test("whitespace collapses the way a browser shows it; <br> is a line break", () => {
    assert.deepEqual(sketch(html("<p>  lots   of\n   space<br>next line  </p>")), ["paragraph:0:lots of space\nnext line"]);
  });

  test("details become a toggle with its contents nested", () => {
    assert.deepEqual(sketch(html("<details><summary>More</summary><p>Hidden</p></details>")), ["toggle:0:More", "paragraph:1:Hidden"]);
  });

  test("bare URLs in pasted text become links", () => {
    const blocks = html("<p>See https://x.dev now</p>");
    assert.equal(blocks[0].runs[1].href, "https://x.dev");
  });
});

describe("plain text", () => {
  test("Markdown is recognised", () => {
    assert.equal(looksLikeMarkdown("# Title\n\nText"), true);
    assert.equal(looksLikeMarkdown("- a\n- b"), true);
    assert.equal(looksLikeMarkdown("Some **bold** words"), true);
    assert.equal(looksLikeMarkdown("```\ncode\n```"), true);
    assert.equal(looksLikeMarkdown("Just a sentence.\nAnd another one."), false);
  });

  test("pasted Markdown lands as blocks", () => {
    assert.deepEqual(sketch(textToBlocks("# Plan\n\n- [ ] ship\n- [x] test\n\n```js\nx()\n```")), [
      "headingh1:0:Plan",
      "todo[ ]:0:ship",
      "todo[x]:0:test",
      "code(js):0:x()",
    ]);
  });

  test("pasted plain lines become one paragraph each, kept literally", () => {
    assert.deepEqual(sketch(textToBlocks("first line\r\n\r\nsecond *line*\n")), ["paragraph:0:first line", "paragraph:0:second *line*"]);
  });
});

describe("blocksFromClipboard", () => {
  test("prefers the editor's own Markdown", () => {
    assert.deepEqual(sketch(blocksFromClipboard({ internal: "## Mine", html: "<h1>Theirs</h1>", text: "x" })), ["headingh2:0:Mine"]);
  });

  test("uses structured HTML over text", () => {
    assert.deepEqual(sketch(blocksFromClipboard({ html: "<ul><li>a</li></ul>", text: "a" })), ["bulleted:0:a"]);
  });

  test("falls back to text when the HTML is just a wrapper", () => {
    assert.equal(htmlHasStructure("<meta charset='utf-8'><span>plain</span>"), false);
    assert.deepEqual(sketch(blocksFromClipboard({ html: "<span>plain</span>", text: "- a\n- b" })), ["bulleted:0:a", "bulleted:0:b"]);
  });

  test("an empty clipboard pastes nothing", () => {
    assert.deepEqual(blocksFromClipboard({}), []);
  });

  test("pasted blocks are fresh blocks without a source to write back", () => {
    const blocks = blocksFromClipboard({ text: "*   wide bullet" });
    assert.equal(blocks[0].origin, undefined);
  });
});
