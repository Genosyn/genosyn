import { test, describe } from "node:test";
import assert from "node:assert/strict";

import JSZip from "jszip";

import { MAX_MARKDOWN_CHARS, createDocx, type CreateDocxOptions } from "./docxCreate.js";
import { DocxPackage } from "./docxPackage.js";
import {
  docxBufferToText,
  readDocx,
  type DocxBlock,
  type DocxParagraphBlock,
  type DocxTableBlock,
} from "./docxRead.js";
import {
  childrenNamed,
  descendantsNamed,
  firstChild,
  parseXml,
  textContent,
  type XmlNode,
} from "./docxXml.js";

/**
 * The writer that turns a model's Markdown into a `.docx`.
 *
 * Everything here is checked twice over, and deliberately so. The bytes go
 * back through {@link readDocx} — the same reader every other surface uses —
 * because a document this service cannot read is a document the employee
 * cannot edit afterwards, which is the whole point of writing Word rather than
 * a PDF. And the package is unzipped so the parts Word alone consults can be
 * inspected: a heading that carries no `Heading1` style still *looks* like a
 * heading in the text, a numbered list whose `w:numId` is missing from
 * `numbering.xml` still reads back as list text, and both open in Word as
 * plain unstyled prose. Reading the text back is not enough to catch either.
 *
 * No test snapshots XML. The claims are the ones a person opening the file
 * would make: this line is a heading, that list starts again at 1, the
 * asterisks inside the code span are still asterisks.
 */

/** Multi-line Markdown, written a line at a time so indentation stays honest. */
const md = (...lines: string[]): string => lines.join("\n");

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the document has no ${what}`);
  return value;
}

type Built = {
  bytes: Buffer;
  /** `word/document.xml` exactly as written, for offset-accurate text reads. */
  source: string;
  body: XmlNode;
  numbering: string;
  rels: string;
  core: string;
};

/** Create a document and open every part a reader would look at. */
async function build(
  markdown: string,
  options: Omit<CreateDocxOptions, "markdown"> = {},
): Promise<Built> {
  const bytes = await createDocx({ markdown, ...options });
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string): Promise<string> =>
    required(zip.file(path), path).async("string");
  const source = await read("word/document.xml");
  return {
    bytes,
    source,
    body: required(firstChild(parseXml(source), "w:body"), "w:body"),
    numbering: await read("word/numbering.xml"),
    rels: await read("word/_rels/document.xml.rels"),
    core: await read("docProps/core.xml"),
  };
}

type RunView = {
  text: string;
  /** Local names of the run's properties, in the order Word will read them. */
  marks: string[];
  /** `w:rFonts/@w:ascii`; empty when the run inherits the document font. */
  font: string;
};

function runsUnder(source: string, node: XmlNode): RunView[] {
  return descendantsNamed(node, "w:r").map((run) => {
    const properties = firstChild(run, "w:rPr");
    return {
      text: textContent(source, run, new Set(["w:rPr"])),
      marks: (properties?.children ?? []).map((child) => child.local),
      font: properties ? (firstChild(properties, "w:rFonts")?.attrs["w:ascii"] ?? "") : "",
    };
  });
}

/** The one run carrying this exact text, so a test can state its formatting. */
function runWith(source: string, node: XmlNode, text: string): RunView {
  const matches = runsUnder(source, node).filter((run) => run.text === text);
  assert.equal(matches.length, 1, `expected exactly one run reading ${JSON.stringify(text)}`);
  return matches[0];
}

function paragraphProperty(paragraph: XmlNode, name: string): XmlNode | undefined {
  const properties = firstChild(paragraph, "w:pPr");
  return properties ? firstChild(properties, name) : undefined;
}

/** `w:ilvl` / `w:numId` for every list paragraph in the body, in order. */
function listMarkers(body: XmlNode): { level: string; numId: string }[] {
  const out: { level: string; numId: string }[] = [];
  for (const paragraph of descendantsNamed(body, "w:p")) {
    const numbering = paragraphProperty(paragraph, "w:numPr");
    if (!numbering) continue;
    out.push({
      level: firstChild(numbering, "w:ilvl")?.attrs["w:val"] ?? "",
      numId: firstChild(numbering, "w:numId")?.attrs["w:val"] ?? "",
    });
  }
  return out;
}

/** Concrete numbering definitions: `w:numId` → the abstract list it uses. */
function declaredNums(numberingXml: string): Map<string, string> {
  const declared = new Map<string, string>();
  for (const num of childrenNamed(parseXml(numberingXml), "w:num")) {
    declared.set(
      num.attrs["w:numId"] ?? "",
      firstChild(num, "w:abstractNumId")?.attrs["w:val"] ?? "",
    );
  }
  return declared;
}

function relationships(
  relsXml: string,
): { id: string; type: string; target: string; mode: string }[] {
  return childrenNamed(parseXml(relsXml), "Relationship").map((rel) => ({
    id: rel.attrs.Id ?? "",
    type: rel.attrs.Type ?? "",
    target: rel.attrs.Target ?? "",
    mode: rel.attrs.TargetMode ?? "",
  }));
}

async function blocksOf(bytes: Buffer): Promise<DocxBlock[]> {
  const outline = await readDocx(bytes, { scope: "body" });
  assert.equal(outline.parts.length, 1, "the body should be the only part");
  return outline.parts[0].blocks;
}

function paragraphsOf(blocks: DocxBlock[]): DocxParagraphBlock[] {
  return blocks.filter((block): block is DocxParagraphBlock => block.kind === "paragraph");
}

function tablesOf(blocks: DocxBlock[]): DocxTableBlock[] {
  return blocks.filter((block): block is DocxTableBlock => block.kind === "table");
}

/** `[style, text]` for each paragraph — `null` where the paragraph is unstyled. */
function styled(blocks: DocxBlock[]): [string | null, string][] {
  return paragraphsOf(blocks).map((block) => [block.style ?? null, block.text]);
}

describe("createDocx - blocks", () => {
  test("each heading level maps onto the matching Word heading style", async () => {
    // The style is what carries the heading into a navigation pane, a table of
    // contents and an export; text that merely starts with a hash does none of
    // those, and looks identical in a plain-text round trip.
    const markdown = md(
      ...[1, 2, 3, 4, 5, 6].map((level) => `${"#".repeat(level)} Level ${level}`),
    );
    const { bytes } = await build(markdown);
    assert.deepEqual(
      styled(await blocksOf(bytes)),
      [1, 2, 3, 4, 5, 6].map((level) => [`Heading${level}`, `Level ${level}`]),
    );
  });

  test("seven hashes is prose, not an invented Heading7", async () => {
    // Word has no Heading7 style; emitting one would leave the paragraph
    // silently unformatted, so the hashes have to survive as text instead.
    const { bytes } = await build("####### Not a heading");
    assert.deepEqual(styled(await blocksOf(bytes)), [[null, "####### Not a heading"]]);
  });

  test("wrapped lines join into one paragraph; a blank line starts a new one", async () => {
    // Models hard-wrap prose. Rendering each wrapped line as its own paragraph
    // would put a paragraph break mid-sentence in the document a human then
    // edits.
    const { bytes } = await build(
      md("The first sentence runs on", "across two source lines.", "", "A separate thought."),
    );
    assert.deepEqual(styled(await blocksOf(bytes)), [
      [null, "The first sentence runs on across two source lines."],
      [null, "A separate thought."],
    ]);
  });

  test("bullets become ListParagraph items on the bullet numbering", async () => {
    const { bytes, body, numbering } = await build(md("- North", "- South"));
    assert.deepEqual(styled(await blocksOf(bytes)), [
      ["ListParagraph", "North"],
      ["ListParagraph", "South"],
    ]);
    assert.deepEqual(listMarkers(body), [
      { level: "0", numId: "1" },
      { level: "0", numId: "1" },
    ]);
    assert.equal(declaredNums(numbering).get("1"), "0", "bullets use the abstract bullet list");
  });

  test("a two-space indent raises the outline level", async () => {
    const { bytes, body } = await build(md("- top", "  - nested", "    - deeper"));
    assert.deepEqual(
      listMarkers(body).map((marker) => marker.level),
      ["0", "1", "2"],
    );
    // The reader has to see the same nesting, or an edit round trip flattens it.
    assert.deepEqual(
      paragraphsOf(await blocksOf(bytes)).map((block) => block.listLevel),
      [0, 1, 2],
    );
  });

  test("two ordered lists get distinct numIds so the second restarts at 1", async () => {
    // Word continues numbering for every paragraph sharing a `w:numId`. Reuse
    // one id and the second list reads 3, 4, 5 — the failure is invisible in
    // the XML text and obvious the moment anyone opens the file.
    const { body, numbering } = await build(
      md("1. first", "2. second", "", "An interruption.", "", "1. restarted", "2. and on"),
    );
    const markers = listMarkers(body);
    assert.equal(markers.length, 4);
    const [firstList, secondList] = [markers.slice(0, 2), markers.slice(2)];
    assert.equal(new Set(firstList.map((m) => m.numId)).size, 1, "one list, one id");
    assert.equal(new Set(secondList.map((m) => m.numId)).size, 1, "one list, one id");
    assert.notEqual(firstList[0].numId, secondList[0].numId);

    const declared = declaredNums(numbering);
    assert.ok(declared.has(firstList[0].numId), "numbering.xml declares the first list");
    assert.ok(declared.has(secondList[0].numId), "numbering.xml declares the second list");
    // Same abstract definition: both lists look identical, they just count
    // separately.
    assert.equal(declared.get(firstList[0].numId), declared.get(secondList[0].numId));
  });

  test("blank lines between numbered steps do not restart the count", async () => {
    // The other half of the fresh-numId rule above: a blank line inside one
    // authored list must not end it. A procedure whose source reads 1., 2., 3.
    // otherwise gets three numbering definitions and prints 1., 1., 1.
    const { body } = await build(md("1. First step", "", "2. Second step", "", "3. Third step"));
    const numIds = listMarkers(body).map((marker) => marker.numId);
    assert.equal(numIds.length, 3);
    assert.equal(
      new Set(numIds).size,
      1,
      `one authored list, one numId (saw ${numIds.join(", ")})`,
    );
  });

  test("every numId a paragraph points at is declared in numbering.xml", async () => {
    // An undeclared id is the quiet version of the bug above: Word drops the
    // list formatting entirely rather than complaining.
    const { body, numbering } = await build(
      md("- a", "", "1. one", "", "- b", "", "1. two", "", "1. three"),
    );
    const declared = declaredNums(numbering);
    const used = [...new Set(listMarkers(body).map((marker) => marker.numId))];
    // Four authored lists, three ids: the two ordered ones each need their own
    // so they restart at 1, while the two bullet lists can share — a bullet
    // carries no counter, so there is nothing for a second definition to
    // restart.
    assert.equal(used.length, 3, `expected several lists, saw ${used.join(", ")}`);
    for (const numId of used) {
      assert.ok(declared.has(numId), `numbering.xml is missing w:num ${numId}`);
    }
  });

  test("a blockquote becomes the Quote style, its lines joined", async () => {
    const { bytes } = await build(md("> Numbers are provisional", "> and may move."));
    assert.deepEqual(styled(await blocksOf(bytes)), [
      ["Quote", "Numbers are provisional and may move."],
    ]);
  });

  test("a thematic break becomes an empty bordered paragraph", async () => {
    const { source, body } = await build(md("Above.", "", "---", "", "Below."));
    const ruled = descendantsNamed(body, "w:p").filter((p) => paragraphProperty(p, "w:pBdr"));
    assert.equal(ruled.length, 1);
    // A rule that carried text would print the dashes as well as the line.
    assert.deepEqual(runsUnder(source, ruled[0]), []);
    assert.equal(descendantsNamed(ruled[0], "w:bottom")[0]?.attrs["w:val"], "single");
  });

  test("a lone \\pagebreak line becomes a real page break", async () => {
    const { bytes, body } = await build(md("Page one.", "", "\\pagebreak", "", "Page two."));
    const breaks = descendantsNamed(body, "w:br").filter((br) => br.attrs["w:type"] === "page");
    assert.equal(breaks.length, 1);
    // And nothing typed the marker out as text.
    assert.deepEqual(styled(await blocksOf(bytes)), [
      [null, "Page one."],
      [null, "\n"],
      [null, "Page two."],
    ]);
  });

  test("a \\pagebreak that follows a line of prose still breaks the page", async () => {
    // The parser breaks a paragraph on a heading, a list item, a quote and a
    // fence, so the other block starters have to break it too. Without that,
    // the marker a model wrote to end a section is printed as the literal word
    // `\pagebreak` in the middle of the sentence.
    const { bytes, body } = await build(md("End of section.", "\\pagebreak", "Next section."));
    assert.equal(
      descendantsNamed(body, "w:br").filter((br) => br.attrs["w:type"] === "page").length,
      1,
    );
    assert.ok(
      !(await docxBufferToText(bytes)).includes("pagebreak"),
      "the marker must not survive as prose",
    );
  });

  test("a table that follows its lead-in sentence is still a table", async () => {
    // Models write the sentence and the table as one unbroken run of lines.
    // Swallowing the table into the paragraph does not merely lose the borders
    // — every row collapses into a wall of pipe characters, and the numbers
    // stop being addressable for a later edit.
    const { bytes } = await build(
      md("Here are the results:", "| Region | Revenue |", "| --- | --- |", "| North | 120 |"),
    );
    const blocks = await blocksOf(bytes);
    assert.deepEqual(styled(blocks), [
      [null, "Here are the results:"],
      [null, ""],
    ]);
    const tables = tablesOf(blocks);
    assert.equal(tables.length, 1, "the table must not be absorbed by the line above it");
    assert.deepEqual(
      tables[0].rows.map((row) => row.cells.map((cellView) => cellView.text)),
      [
        ["Region", "Revenue"],
        ["North", "120"],
      ],
    );
  });

  test("a fenced block becomes one CodeBlock paragraph per line", async () => {
    const { bytes, source, body } = await build(md("```js", "const a = 1;", "const b = 2;", "```"));
    assert.deepEqual(styled(await blocksOf(bytes)), [
      ["CodeBlock", "const a = 1;"],
      ["CodeBlock", "const b = 2;"],
    ]);
    // The info string labels the fence; printing it would corrupt the snippet.
    assert.ok(!source.includes(">js<"));
    assert.equal(runWith(source, body, "const a = 1;").font, "Consolas");
  });

  test("Markdown inside a fence is code, not formatting", async () => {
    // Sample Markdown in a document about Markdown is a real request, and
    // re-parsing the fence would eat the very characters being demonstrated.
    const { bytes, body } = await build(md("```", "**not bold** and *not italic*", "```"));
    assert.deepEqual(styled(await blocksOf(bytes)), [
      ["CodeBlock", "**not bold** and *not italic*"],
    ]);
    assert.equal(descendantsNamed(body, "w:b").length, 0);
    assert.equal(descendantsNamed(body, "w:i").length, 0);
  });
});

describe("createDocx - tables", () => {
  const TABLE = md(
    "| Region | Revenue | Owner |",
    "| --- | :---: | ---: |",
    "| North | 120 | Ada |",
    "| South |",
  );

  test("the header row is bold and repeats across pages", async () => {
    const { bytes, source, body } = await build(TABLE);
    const [table] = tablesOf(await blocksOf(bytes));
    assert.equal(table.rows[0].header, true, "w:tblHeader repeats the row on page two");
    assert.ok(!table.rows[1].header);

    const headerRow = descendantsNamed(body, "w:tr")[0];
    assert.deepEqual(
      runsUnder(source, headerRow).map((run) => [run.text, run.marks]),
      [
        ["Region", ["b"]],
        ["Revenue", ["b"]],
        ["Owner", ["b"]],
      ],
    );
    // Body cells must not inherit the emphasis.
    assert.deepEqual(runWith(source, body, "North").marks, []);
  });

  test("alignment comes from the divider row", async () => {
    const { body } = await build(TABLE);
    const alignments = descendantsNamed(body, "w:tr").map((row) =>
      descendantsNamed(row, "w:tc").map((cellNode) => {
        const paragraph = descendantsNamed(cellNode, "w:p")[0];
        return paragraphProperty(paragraph, "w:jc")?.attrs["w:val"] ?? "left";
      }),
    );
    for (const row of alignments) assert.deepEqual(row, ["left", "center", "right"]);
  });

  test("a short row is padded, never dropped", async () => {
    // Hand-written Markdown is ragged constantly. Dropping the row would lose
    // the only mention of South from the report.
    const { bytes } = await build(TABLE);
    const [table] = tablesOf(await blocksOf(bytes));
    assert.equal(table.rows.length, 3);
    assert.deepEqual(
      table.rows.map((row) => row.cells.map((cellView) => cellView.text)),
      [
        ["Region", "Revenue", "Owner"],
        ["North", "120", "Ada"],
        ["South", "", ""],
      ],
    );
  });
});

describe("createDocx - inline formatting", () => {
  test("bold, italic, strikethrough and code each get their own run", async () => {
    const { source, body } = await build(
      "Plain **bold** then *italic* plus ~~gone~~ with `code` here.",
    );
    assert.deepEqual(runWith(source, body, "bold").marks, ["b"]);
    assert.deepEqual(runWith(source, body, "italic").marks, ["i"]);
    assert.deepEqual(runWith(source, body, "gone").marks, ["strike"]);
    assert.deepEqual(runWith(source, body, "code").marks, ["rFonts", "sz"]);
    assert.equal(runWith(source, body, "code").font, "Consolas");
    assert.deepEqual(runWith(source, body, "Plain ").marks, [], "surrounding prose stays plain");
  });

  test("the emphasis markers do not survive as text", async () => {
    const { bytes } = await build("Plain **bold** then *italic* plus ~~gone~~ with `code` here.");
    assert.deepEqual(styled(await blocksOf(bytes)), [
      [null, "Plain bold then italic plus gone with code here."],
    ]);
  });

  test("a code span keeps its literal asterisks", async () => {
    // The case a single pass of regex replacements gets wrong: documenting
    // `**bold**` has to print the asterisks, not apply them.
    const { bytes, source, body } = await build("Write `**literal**` to escape it.");
    assert.equal(descendantsNamed(body, "w:b").length, 0);
    assert.equal(runWith(source, body, "**literal**").font, "Consolas");
    assert.deepEqual(styled(await blocksOf(bytes)), [[null, "Write **literal** to escape it."]]);
  });

  test("an underscore inside a word is a word, not emphasis", async () => {
    // `snake_case_name` in a spec turns half an identifier italic and, worse,
    // eats the underscores on the way through.
    const { bytes, body } = await build("Set the snake_case_name field before saving.");
    assert.equal(descendantsNamed(body, "w:i").length, 0);
    assert.deepEqual(styled(await blocksOf(bytes)), [
      [null, "Set the snake_case_name field before saving."],
    ]);
  });

  test("a link becomes a hyperlink backed by an external relationship", async () => {
    const { bytes, source, body, rels } = await build(
      "See [the docs](https://example.com/guide?a=1&b=2) and [the FAQ](https://example.com/faq).",
    );
    const hyperlinks = descendantsNamed(body, "w:hyperlink");
    assert.equal(hyperlinks.length, 2);
    assert.deepEqual(
      hyperlinks.map((link) => runsUnder(source, link).map((run) => run.text)),
      [["the docs"], ["the FAQ"]],
    );
    assert.ok(runsUnder(source, hyperlinks[0])[0].marks.includes("rStyle"), "styled as a link");

    const ids = hyperlinks.map((link) => link.attrs["r:id"]);
    assert.equal(new Set(ids).size, 2, "two links, two relationship ids");
    const external = new Map(
      relationships(rels)
        .filter((rel) => rel.mode === "External")
        .map((rel) => [rel.id, rel.target]),
    );
    // An unresolvable r:id makes Word declare the document corrupt.
    assert.equal(external.get(ids[0]), "https://example.com/guide?a=1&b=2");
    assert.equal(external.get(ids[1]), "https://example.com/faq");

    assert.deepEqual(styled(await blocksOf(bytes)), [[null, "See the docs and the FAQ."]]);
  });

  test("XML metacharacters are escaped and read back unchanged", async () => {
    // Prose about markup is exactly what these documents are full of; an
    // unescaped `<` makes the package unopenable rather than merely wrong.
    const prose = 'Use <input> when a & b say "hi" — see 5 > 4.';
    const { bytes, source } = await build(prose);
    assert.ok(!source.includes("<input>"), "the tag must not be written as markup");
    assert.ok(source.includes("&lt;input&gt;"));
    assert.ok(source.includes("&amp;"));
    assert.deepEqual(styled(await blocksOf(bytes)), [[null, prose]]);
  });
});

describe("createDocx - page setup and properties", () => {
  const pageSize = (body: XmlNode): Record<string, string> =>
    required(firstChild(required(firstChild(body, "w:sectPr"), "w:sectPr"), "w:pgSz"), "w:pgSz")
      .attrs;

  test("A4 is the default and Letter is honoured", async () => {
    const a4 = await build("Hello.");
    assert.equal(pageSize(a4.body)["w:w"], "11906");
    assert.equal(pageSize(a4.body)["w:h"], "16838");

    const letter = await build("Hello.", { pageSize: "letter" });
    assert.equal(pageSize(letter.body)["w:w"], "12240");
    assert.equal(pageSize(letter.body)["w:h"], "15840");
  });

  test("landscape swaps the page dimensions and says so", async () => {
    // Word needs both: the orientation flag drives the print dialog, the
    // swapped extents drive the layout. One without the other prints wrong.
    const { body } = await build("Hello.", { pageSize: "letter", landscape: true });
    assert.equal(pageSize(body)["w:w"], "15840");
    assert.equal(pageSize(body)["w:h"], "12240");
    assert.equal(pageSize(body)["w:orient"], "landscape");
  });

  test("title and author land in the core properties", async () => {
    const { core } = await build("Hello.", { title: "Q3 Review & Outlook", author: "Ada <Ada>" });
    const root = parseXml(core);
    assert.equal(
      textContent(core, required(firstChild(root, "dc:title"), "dc:title")),
      "Q3 Review & Outlook",
    );
    assert.equal(
      textContent(core, required(firstChild(root, "dc:creator"), "dc:creator")),
      "Ada <Ada>",
    );
  });

  test("an untitled document still has usable properties", async () => {
    const { core } = await build("Hello.");
    const root = parseXml(core);
    assert.equal(textContent(core, required(firstChild(root, "dc:title"), "dc:title")), "Document");
    assert.equal(
      textContent(core, required(firstChild(root, "dc:creator"), "dc:creator")),
      "Genosyn",
    );
  });
});

describe("createDocx - limits and edge cases", () => {
  test("empty Markdown still produces a document the reader can open", async () => {
    // A model that produced nothing should get back a blank page, not a file
    // Word refuses: a `w:body` with no paragraph at all is invalid OOXML.
    for (const markdown of ["", "   \n\n  \n"]) {
      const bytes = await createDocx({ markdown });
      const outline = await readDocx(bytes);
      assert.equal(outline.wordCount, 0);
      assert.ok(outline.paragraphCount >= 1, "the body needs at least one paragraph");
      assert.equal(await docxBufferToText(bytes), "");
    }
  });

  test("Markdown over the ceiling is refused, with the numbers in the message", async () => {
    const oversized = "x".repeat(MAX_MARKDOWN_CHARS + 1);
    await assert.rejects(
      () => createDocx({ markdown: oversized }),
      (error: Error) => {
        assert.match(error.message, new RegExp(String(MAX_MARKDOWN_CHARS)));
        assert.match(error.message, new RegExp(String(MAX_MARKDOWN_CHARS + 1)));
        return true;
      },
    );
  });
});

describe("createDocx - the rest of the system can read the result", () => {
  const REPORT = md(
    "# Quarterly Report",
    "",
    "Revenue grew in every region.",
    "",
    "- North",
    "- South",
    "",
    "| Region | Revenue |",
    "| --- | --- |",
    "| North | 120 |",
    "",
    "> Numbers are provisional.",
  );

  test("DocxPackage opens it and finds the parts the tools reach for", async () => {
    const bytes = await createDocx({ markdown: REPORT });
    const pkg = await DocxPackage.open(bytes);
    for (const part of [
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
      "word/settings.xml",
      "word/_rels/document.xml.rels",
      "[Content_Types].xml",
      "docProps/core.xml",
    ]) {
      assert.ok(pkg.has(part), `the package is missing ${part}`);
    }
    // Only the body: a created document has no headers to fold in.
    assert.deepEqual(pkg.contentParts(), ["word/document.xml"]);
  });

  test("the styles and numbering the body references are wired up as relationships", async () => {
    // Word resolves these by relationship, not by filename; a missing one
    // silently drops every heading and every list marker.
    const { rels } = await build(REPORT);
    const targets = relationships(rels).map((rel) => rel.target);
    for (const target of ["styles.xml", "numbering.xml", "settings.xml"]) {
      assert.ok(targets.includes(target), `document.xml.rels is missing ${target}`);
    }
  });

  test("docxBufferToText returns the prose, the list and the table", async () => {
    const bytes = await createDocx({ markdown: REPORT });
    assert.equal(
      await docxBufferToText(bytes),
      md(
        "Quarterly Report",
        "Revenue grew in every region.",
        "- North",
        "- South",
        "| Region | Revenue |",
        "| North | 120 |",
        "",
        "Numbers are provisional.",
      ),
    );
  });
});
