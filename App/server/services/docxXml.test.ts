import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyEdits,
  childrenNamed,
  decodeXmlText,
  descendantsNamed,
  escapeXmlAttr,
  escapeXmlText,
  firstChild,
  innerXml,
  outerXml,
  parseXml,
  stripXmlIllegalChars,
  textContent,
  walkXml,
  XmlParseError,
} from "./docxXml.js";

/**
 * The reader every Word tool sits on.
 *
 * Its whole contract is that offsets are exact: an edit is a splice into the
 * original string, so a node whose reported range is one character out
 * corrupts a document rather than failing loudly. Most of what follows is
 * therefore about positions rather than about parsing — the parse is the easy
 * part, and getting `end` wrong on a self-closing tag is the bug that reaches
 * a customer as "Word says this file is unreadable".
 */

describe("parseXml", () => {
  test("reports offsets that slice back to the original source", () => {
    const source = '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>';
    const root = parseXml(source);
    const text = descendantsNamed(root, "w:t")[0];
    assert.equal(outerXml(source, text), "<w:t>Hello</w:t>");
    assert.equal(innerXml(source, text), "Hello");
    assert.equal(source.slice(root.start, root.end), source);
  });

  test("a self-closing element ends after its own slash-bracket", () => {
    // Getting this wrong by one character is how a splice eats the next tag.
    const source = "<w:p><w:br/><w:t>x</w:t></w:p>";
    const root = parseXml(source);
    const br = descendantsNamed(root, "w:br")[0];
    assert.equal(br.selfClosing, true);
    assert.equal(source.slice(br.start, br.end), "<w:br/>");
    assert.equal(br.innerStart, br.end);
    assert.equal(innerXml(source, br), "");
  });

  test("keeps attributes in a map, decoded", () => {
    const source = '<w:t xml:space="preserve" w:val="a &amp; b">x</w:t>';
    const node = parseXml(source);
    assert.equal(node.attrs["xml:space"], "preserve");
    assert.equal(node.attrs["w:val"], "a & b");
  });

  test("accepts single-quoted attribute values and whitespace around =", () => {
    const node = parseXml("<w:t w:val = 'yes' >x</w:t>");
    assert.equal(node.attrs["w:val"], "yes");
  });

  test("splits the qualified name into a local name", () => {
    const node = parseXml("<w:tbl/>");
    assert.equal(node.name, "w:tbl");
    assert.equal(node.local, "tbl");
    assert.equal(parseXml("<body/>").local, "body");
  });

  test("skips the prologue, comments and processing instructions", () => {
    const source =
      '<?xml version="1.0"?><!-- a note --><w:body><?mso-application x?><w:p/></w:body>';
    const root = parseXml(source);
    assert.equal(root.name, "w:body");
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].name, "w:p");
  });

  test("a comment containing a tag does not become an element", () => {
    const root = parseXml("<w:p><!-- <w:r>ghost</w:r> --><w:t>real</w:t></w:p>");
    assert.deepEqual(
      root.children.map((c) => c.name),
      ["w:t"],
    );
  });

  test("skips a doctype with an internal subset containing a >", () => {
    const root = parseXml('<!DOCTYPE x [ <!ENTITY y "a>b"> ]><w:p/>');
    assert.equal(root.name, "w:p");
  });

  test("builds parent links and preserves document order", () => {
    const root = parseXml("<w:body><w:p><w:r/></w:p><w:tbl/></w:body>");
    const run = descendantsNamed(root, "w:r")[0];
    assert.equal(run.parent?.name, "w:p");
    assert.equal(run.parent?.parent, root);
    const seen: string[] = [];
    walkXml(root, (node) => seen.push(node.name));
    assert.deepEqual(seen, ["w:body", "w:p", "w:r", "w:tbl"]);
  });

  test("refuses malformed input rather than guessing", () => {
    const bad: [string, RegExp][] = [
      ["<w:p><w:r></w:p>", /does not match open/],
      ["<w:p>", /Unclosed element/],
      ["</w:p>", /with nothing open/],
      ["", /no root element/],
      ["<w:p/><w:tbl/>", /more than one root/],
      ["<w:t val>x</w:t>", /has no value/],
      ["<w:t val=x>y</w:t>", /is not quoted/],
      ["<w:p><!-- never ends", /Unterminated comment/],
    ];
    for (const [source, pattern] of bad) {
      assert.throws(() => parseXml(source), pattern, `expected ${source} to be refused`);
    }
  });

  test("a parse error is a 400 and points at the offset", () => {
    try {
      parseXml("<w:p><w:r></w:p>");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof XmlParseError);
      assert.equal(error.status, 400);
      assert.equal(error.offset, 10);
    }
  });
});

describe("navigation helpers", () => {
  const source =
    "<w:body><w:p><w:r><w:t>a</w:t></w:r></w:p>" +
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>";
  const root = parseXml(source);

  test("childrenNamed looks only one level down", () => {
    assert.equal(childrenNamed(root, "w:p").length, 1);
    assert.equal(childrenNamed(root, "w:r").length, 0);
  });

  test("firstChild returns undefined rather than throwing", () => {
    assert.equal(firstChild(root, "w:tbl")?.name, "w:tbl");
    assert.equal(firstChild(root, "w:sectPr"), undefined);
  });

  test("descendantsNamed can prune a subtree", () => {
    // Reading a paragraph's own runs must not pull in the runs of a table
    // nested inside it, or a cell's text would be reported twice.
    assert.equal(descendantsNamed(root, "w:t").length, 2);
    assert.equal(descendantsNamed(root, "w:t", new Set(["w:tbl"])).length, 1);
  });
});

describe("textContent", () => {
  test("stitches text split across runs", () => {
    // Word splits a sentence wherever it likes; the reader must not.
    const source =
      "<w:p><w:r><w:t>Full</w:t></w:r><w:r><w:t> nam</w:t></w:r><w:r><w:t>e:</w:t></w:r></w:p>";
    assert.equal(textContent(source, parseXml(source)), "Full name:");
  });

  test("skips the subtrees it is told to skip", () => {
    const source =
      "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>kept</w:t></w:r>" +
      '<w:r><w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r></w:p>';
    const skip = new Set(["w:rPr", "w:instrText"]);
    assert.equal(textContent(source, parseXml(source), skip), "kept");
  });

  test("decodes entities in character data", () => {
    const source = "<w:t>Smith &amp; Sons &lt;Ltd&gt;</w:t>";
    assert.equal(textContent(source, parseXml(source)), "Smith & Sons <Ltd>");
  });

  test("a self-closing element has no text", () => {
    const source = "<w:t/>";
    assert.equal(textContent(source, parseXml(source)), "");
  });
});

describe("decodeXmlText", () => {
  test("handles the five named entities and numeric references", () => {
    assert.equal(
      decodeXmlText("&amp;&lt;&gt;&quot;&apos;&#65;&#x42;"),
      "&<>\"'AB",
    );
  });

  test("leaves an unknown entity alone rather than dropping it", () => {
    // Silently deleting text is worse than showing it verbatim: an employee
    // reading "&nbsp;" knows something is odd, an employee reading nothing
    // does not.
    assert.equal(decodeXmlText("a &nbsp; b"), "a &nbsp; b");
    assert.equal(decodeXmlText("&#x110000;"), "&#x110000;");
  });

  test("returns the input untouched when there is nothing to decode", () => {
    assert.equal(decodeXmlText("plain text"), "plain text");
  });
});

describe("escaping", () => {
  test("escapes the characters that would end an element early", () => {
    assert.equal(escapeXmlText('a & b < c > d'), "a &amp; b &lt; c &gt; d");
    assert.equal(escapeXmlAttr('say "hi" & <bye>'), "say &quot;hi&quot; &amp; &lt;bye&gt;");
  });

  test("drops characters XML cannot carry at all", () => {
    // A model writing an answer it read out of a PDF carries stray control
    // bytes through with it, and Word refuses to open a file containing one.
    const dirty = "a\u0000b\u0008c\u000Bd\u000Ce\u001Ff\uFFFEg";
    assert.equal(stripXmlIllegalChars(dirty), "abcdefg");
  });

  test("keeps tab, newline and carriage return, which XML does allow", () => {
    assert.equal(stripXmlIllegalChars("a\tb\nc\rd"), "a\tb\nc\rd");
  });

  test("drops an unpaired surrogate but keeps a real astral character", () => {
    assert.equal(stripXmlIllegalChars("a\uD800b"), "ab");
    assert.equal(stripXmlIllegalChars("a\uDC00b"), "ab");
    assert.equal(stripXmlIllegalChars("emoji \u{1F600}"), "emoji \u{1F600}");
  });

  test("round-trips through decode", () => {
    const original = 'Ada & "Lovelace" <first>';
    assert.equal(decodeXmlText(escapeXmlText(original)), original);
  });
});

describe("applyEdits", () => {
  const source = "0123456789";

  test("returns the source untouched when there is nothing to do", () => {
    assert.equal(applyEdits(source, []), source);
  });

  test("applies several splices without earlier ones shifting later ones", () => {
    const out = applyEdits(source, [
      { start: 8, end: 10, replacement: "Z" },
      { start: 0, end: 2, replacement: "A" },
      { start: 4, end: 5, replacement: "" },
    ]);
    assert.equal(out, "A23567Z");
  });

  test("keeps insertions at the same offset in the order given", () => {
    // Three bullets inserted after one paragraph must land in the order the
    // caller listed them, not reversed.
    const out = applyEdits(source, [
      { start: 5, end: 5, replacement: "<a>" },
      { start: 5, end: 5, replacement: "<b>" },
      { start: 5, end: 5, replacement: "<c>" },
    ]);
    assert.equal(out, "01234<a><b><c>56789");
  });

  test("refuses overlapping edits instead of picking a winner", () => {
    // Two operations claiming the same run is a caller bug, and the result
    // would depend on ordering — so it fails loudly and the whole batch is
    // abandoned rather than half-applied.
    assert.throws(
      () =>
        applyEdits(source, [
          { start: 2, end: 6, replacement: "x" },
          { start: 4, end: 8, replacement: "y" },
        ]),
      /overlap/,
    );
  });

  test("allows an edit that starts exactly where the previous one ends", () => {
    const out = applyEdits(source, [
      { start: 0, end: 5, replacement: "A" },
      { start: 5, end: 10, replacement: "B" },
    ]);
    assert.equal(out, "AB");
  });

  test("refuses a range outside the document", () => {
    assert.throws(() => applyEdits(source, [{ start: 0, end: 99, replacement: "" }]), /outside/);
    assert.throws(() => applyEdits(source, [{ start: -1, end: 2, replacement: "" }]), /outside/);
    assert.throws(() => applyEdits(source, [{ start: 6, end: 2, replacement: "" }]), /outside/);
  });

  test("leaves every byte it was not asked about identical", () => {
    // The property the whole module exists for: a document keeps its revision
    // ids, its vendor extensions and its attribute order because those bytes
    // are never re-serialized, only copied.
    const document =
      '<w:p w:rsidR="00A1" w14:paraId="7B3C"><w:r><w:rPr><w:rFonts w:ascii="Calibri"/>' +
      '</w:rPr><w:t xml:space="preserve">old</w:t></w:r></w:p>';
    const root = parseXml(document);
    const text = descendantsNamed(root, "w:t")[0];
    const out = applyEdits(document, [
      { start: text.innerStart, end: text.innerEnd, replacement: "new" },
    ]);
    assert.equal(out, document.replace(">old<", ">new<"));
    assert.ok(out.includes('w14:paraId="7B3C"'));
    assert.ok(out.includes('w:rsidR="00A1"'));
  });
});
