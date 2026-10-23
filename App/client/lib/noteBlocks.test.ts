import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { plainText, type Run } from "./noteInline.js";
import { type Block, parseDoc, serializeDoc } from "./noteMarkdown.js";
import {
  backspaceAtStart,
  blockRange,
  createBlock,
  deleteAtEnd,
  deleteBlocks,
  dropDepth,
  duplicateBlocks,
  ensureBlocks,
  indentBlocks,
  insertBlockAbove,
  insertBlockBelow,
  insertParagraphAfter,
  kindOf,
  moveBlocks,
  moveBlocksBy,
  nextVisible,
  normalizeDepths,
  ordinalLabel,
  outdentBlocks,
  pasteBlocks,
  previousVisible,
  reconcileBlocks,
  selectionSpan,
  setToggleOpen,
  splitBlock,
  turnInto,
  visibility,
} from "./noteBlocks.js";

function runs(text: string): Run[] {
  return text ? [{ text }] : [];
}

function b(type: Block["type"], text = "", extra: Partial<Block> = {}): Block {
  return createBlock(type, { runs: runs(text), ...extra });
}

/** The blocks as `type:depth:text` strings, for compact assertions. */
function sketch(blocks: readonly Block[]): string[] {
  return blocks.map((x) => {
    const text = x.type === "code" || x.type === "raw" || x.type === "table" ? x.text : plainText(x.runs);
    const tail = x.type === "todo" ? `[${x.checked ? "x" : " "}]` : x.type === "heading" ? `h${x.level}` : "";
    return `${x.type}${tail}:${x.depth}:${text}`;
  });
}

describe("splitBlock (Enter)", () => {
  test("splits a paragraph at the caret and moves the caret to the new block", () => {
    const doc = [b("paragraph", "Hello world")];
    const result = splitBlock(doc, doc[0].id, 5);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:Hello", "paragraph:0: world"]);
    assert.deepEqual(result.focus, { id: result.blocks[1].id, start: 0 });
  });

  test("replaces a selection before splitting", () => {
    const doc = [b("paragraph", "Hello brave world")];
    const result = splitBlock(doc, doc[0].id, 5, 11);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:Hello", "paragraph:0: world"]);
  });

  test("a list item continues the list; a to-do starts unchecked", () => {
    const bullets = [b("bulleted", "one")];
    assert.deepEqual(sketch(splitBlock(bullets, bullets[0].id, 3).blocks), ["bulleted:0:one", "bulleted:0:"]);
    const todos = [b("todo", "done", { checked: true })];
    assert.deepEqual(sketch(splitBlock(todos, todos[0].id, 4).blocks), ["todo[x]:0:done", "todo[ ]:0:"]);
    const numbered = [b("numbered", "first")];
    assert.deepEqual(sketch(splitBlock(numbered, numbered[0].id, 5).blocks), ["numbered:0:first", "numbered:0:"]);
  });

  test("a heading is followed by plain text", () => {
    const doc = [b("heading", "Title", { level: 1 })];
    assert.deepEqual(sketch(splitBlock(doc, doc[0].id, 5).blocks), ["headingh1:0:Title", "paragraph:0:"]);
  });

  test("Enter on an empty list item steps out: outdent first, then plain text", () => {
    const doc = [b("bulleted", "parent"), b("bulleted", "", { depth: 1 })];
    const once = splitBlock(doc, doc[1].id, 0);
    assert.deepEqual(sketch(once.blocks), ["bulleted:0:parent", "bulleted:0:"]);
    const twice = splitBlock(once.blocks, doc[1].id, 0);
    assert.deepEqual(sketch(twice.blocks), ["bulleted:0:parent", "paragraph:0:"]);
    assert.deepEqual(twice.focus, { id: doc[1].id, start: 0 });
  });

  test("Enter on an empty line inside a toggle or list item steps out of it", () => {
    const doc = [b("toggle", "More", { open: true }), b("paragraph", "inside", { depth: 1 }), b("paragraph", "", { depth: 1 })];
    const result = splitBlock(doc, doc[2].id, 0);
    assert.deepEqual(sketch(result.blocks), ["toggle:0:More", "paragraph:1:inside", "paragraph:0:"]);
    assert.deepEqual(result.focus, { id: doc[2].id, start: 0 });
  });

  test("Enter on an empty quote, callout or toggle turns it into text", () => {
    for (const type of ["quote", "callout", "toggle"] as const) {
      const doc = [b(type, "")];
      assert.deepEqual(sketch(splitBlock(doc, doc[0].id, 0).blocks), ["paragraph:0:"]);
    }
  });

  test("Enter at the start of a non-empty line opens an empty block above and keeps the caret", () => {
    const doc = [b("bulleted", "item")];
    const result = splitBlock(doc, doc[0].id, 0);
    assert.deepEqual(sketch(result.blocks), ["bulleted:0:", "bulleted:0:item"]);
    assert.deepEqual(result.focus, { id: doc[0].id, start: 0 });
  });

  test("a parent with children shown starts its first child", () => {
    const doc = [b("bulleted", "parent"), b("bulleted", "child", { depth: 1 })];
    const result = splitBlock(doc, doc[0].id, 6);
    assert.deepEqual(sketch(result.blocks), ["bulleted:0:parent", "bulleted:1:", "bulleted:1:child"]);
  });

  test("an open toggle starts its first child as text; a closed one adds a toggle after its children", () => {
    const open = [b("toggle", "More", { open: true })];
    assert.deepEqual(sketch(splitBlock(open, open[0].id, 4).blocks), ["toggle:0:More", "paragraph:1:"]);
    const withChild = [b("toggle", "More", { open: true }), b("paragraph", "hidden", { depth: 1 })];
    assert.deepEqual(sketch(splitBlock(withChild, withChild[0].id, 4).blocks), [
      "toggle:0:More",
      "paragraph:1:",
      "paragraph:1:hidden",
    ]);
    const closed = [b("toggle", "More", { open: false }), b("paragraph", "hidden", { depth: 1 })];
    assert.deepEqual(sketch(splitBlock(closed, closed[0].id, 4).blocks), [
      "toggle:0:More",
      "paragraph:1:hidden",
      "toggle:0:",
    ]);
  });

  test("formatting stays with each half", () => {
    const doc = [createBlock("paragraph", { runs: [{ text: "bold", bold: true }, { text: " plain" }] })];
    const result = splitBlock(doc, doc[0].id, 2);
    assert.deepEqual(result.blocks[0].runs, [{ text: "bo", bold: true }]);
    assert.deepEqual(result.blocks[1].runs, [{ text: "ld", bold: true }, { text: " plain" }]);
  });

  test("an unknown block id changes nothing", () => {
    const doc = [b("paragraph", "x")];
    assert.equal(splitBlock(doc, "missing", 0).blocks, doc);
  });
});

describe("backspaceAtStart", () => {
  test("a styled block becomes plain text first", () => {
    for (const type of ["heading", "bulleted", "numbered", "todo", "quote", "callout", "toggle"] as const) {
      const doc = [b("paragraph", "above"), b(type, "text", type === "heading" ? { level: 2 } : {})];
      const result = backspaceAtStart(doc, doc[1].id);
      assert.deepEqual(sketch(result.blocks), ["paragraph:0:above", "paragraph:0:text"], type);
      assert.equal(result.blocks[1].level, undefined);
    }
  });

  test("a nested paragraph steps out next", () => {
    const doc = [b("bulleted", "parent"), b("paragraph", "child", { depth: 1 })];
    const result = backspaceAtStart(doc, doc[1].id);
    assert.deepEqual(sketch(result.blocks), ["bulleted:0:parent", "paragraph:0:child"]);
  });

  test("then merges into the block above, caret at the join", () => {
    const doc = [b("paragraph", "Hello "), b("paragraph", "world")];
    const result = backspaceAtStart(doc, doc[1].id);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:Hello world"]);
    assert.deepEqual(result.focus, { id: doc[0].id, start: 6 });
  });

  test("merges into the last visible block, skipping a closed toggle's children", () => {
    const doc = [b("toggle", "Summary", { open: false }), b("paragraph", "hidden", { depth: 1 }), b("paragraph", "after")];
    const result = backspaceAtStart(doc, doc[2].id);
    assert.deepEqual(sketch(result.blocks), ["toggle:0:Summaryafter", "paragraph:1:hidden"]);
  });

  test("removes a divider or image above instead of merging", () => {
    const doc = [b("paragraph", "a"), b("divider"), b("paragraph", "b")];
    const result = backspaceAtStart(doc, doc[2].id);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:a", "paragraph:0:b"]);
  });

  test("an empty paragraph after a code block deletes itself into the code", () => {
    const doc = [createBlock("code", { text: "x = 1" }), b("paragraph", "")];
    const result = backspaceAtStart(doc, doc[1].id);
    assert.deepEqual(sketch(result.blocks), ["code:0:x = 1"]);
    assert.deepEqual(result.focus, { id: doc[0].id, start: 5 });
  });

  test("text after a code block joins it on a new line", () => {
    const doc = [createBlock("code", { text: "x = 1" }), b("paragraph", "y = 2")];
    assert.deepEqual(sketch(backspaceAtStart(doc, doc[1].id).blocks), ["code:0:x = 1\ny = 2"]);
  });

  test("an empty code block becomes a paragraph; a full one is left alone", () => {
    const empty = [createBlock("code", { text: "" })];
    assert.deepEqual(sketch(backspaceAtStart(empty, empty[0].id).blocks), ["paragraph:0:"]);
    const full = [createBlock("code", { text: "x" })];
    assert.equal(backspaceAtStart(full, full[0].id).blocks, full);
  });

  test("the first block of the page has nothing to merge into", () => {
    const doc = [b("paragraph", "first")];
    assert.equal(backspaceAtStart(doc, doc[0].id).blocks, doc);
  });
});

describe("deleteAtEnd", () => {
  test("pulls the next block's text up", () => {
    const doc = [b("paragraph", "one"), b("bulleted", "two")];
    const result = deleteAtEnd(doc, doc[0].id);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:onetwo"]);
    assert.deepEqual(result.focus, { id: doc[0].id, start: 3 });
  });

  test("removes a divider below", () => {
    const doc = [b("paragraph", "one"), b("divider"), b("paragraph", "two")];
    assert.deepEqual(sketch(deleteAtEnd(doc, doc[0].id).blocks), ["paragraph:0:one", "paragraph:0:two"]);
  });

  test("does nothing at the end of the page or before a code block", () => {
    const doc = [b("paragraph", "one"), createBlock("code", { text: "x" })];
    assert.equal(deleteAtEnd(doc, doc[0].id).blocks, doc);
    assert.equal(deleteAtEnd(doc, doc[1].id).blocks, doc);
  });
});

describe("nesting (Tab / Shift+Tab)", () => {
  test("Tab nests a block under the list item above, with its children", () => {
    const doc = [b("bulleted", "a"), b("bulleted", "b"), b("bulleted", "c", { depth: 1 })];
    const result = indentBlocks(doc, [doc[1].id]);
    assert.deepEqual(sketch(result!.blocks), ["bulleted:0:a", "bulleted:1:b", "bulleted:2:c"]);
  });

  test("Tab can't nest the first block, or under a paragraph", () => {
    const first = [b("bulleted", "a")];
    assert.equal(indentBlocks(first, [first[0].id]), null);
    const underParagraph = [b("paragraph", "a"), b("paragraph", "b")];
    assert.equal(indentBlocks(underParagraph, [underParagraph[1].id]), null);
  });

  test("Tab nests a paragraph under a to-do, and opens a closed toggle it nests into", () => {
    const todo = [b("todo", "task"), b("paragraph", "detail")];
    assert.deepEqual(sketch(indentBlocks(todo, [todo[1].id])!.blocks), ["todo[ ]:0:task", "paragraph:1:detail"]);
    const toggle = [b("toggle", "t", { open: false }), b("paragraph", "p")];
    const result = indentBlocks(toggle, [toggle[1].id])!;
    assert.equal(result.blocks[0].open, true);
    assert.equal(result.blocks[1].depth, 1);
  });

  test("Tab over several selected blocks nests them all", () => {
    const doc = [b("bulleted", "a"), b("bulleted", "b"), b("bulleted", "c")];
    assert.deepEqual(sketch(indentBlocks(doc, [doc[1].id, doc[2].id])!.blocks), [
      "bulleted:0:a",
      "bulleted:1:b",
      "bulleted:1:c",
    ]);
  });

  test("Shift+Tab steps a block and its children out", () => {
    const doc = [b("bulleted", "a"), b("bulleted", "b", { depth: 1 }), b("bulleted", "c", { depth: 2 })];
    assert.deepEqual(sketch(outdentBlocks(doc, [doc[1].id])!.blocks), ["bulleted:0:a", "bulleted:0:b", "bulleted:1:c"]);
  });

  test("Shift+Tab at the top level does nothing", () => {
    const doc = [b("bulleted", "a")];
    assert.equal(outdentBlocks(doc, [doc[0].id]), null);
  });

  test("normalizeDepths keeps children only under list items and toggles", () => {
    const doc = [b("paragraph", "p"), b("bulleted", "x", { depth: 3 }), b("bulleted", "y", { depth: 5 })];
    assert.deepEqual(sketch(normalizeDepths(doc)), ["paragraph:0:p", "bulleted:0:x", "bulleted:1:y"]);
    const fine = [b("bulleted", "x")];
    assert.equal(normalizeDepths(fine), fine);
  });
});

describe("moving blocks", () => {
  test("drag a block (with children) below another", () => {
    const doc = [b("bulleted", "a"), b("bulleted", "a1", { depth: 1 }), b("paragraph", "b"), b("paragraph", "c")];
    const result = moveBlocks(doc, [doc[0].id], 4)!;
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:b", "paragraph:0:c", "bulleted:0:a", "bulleted:1:a1"]);
    assert.deepEqual(result.select, [doc[0].id]);
  });

  test("drag a block up to the top", () => {
    const doc = [b("paragraph", "a"), b("paragraph", "b"), b("paragraph", "c")];
    assert.deepEqual(sketch(moveBlocks(doc, [doc[2].id], 0)!.blocks), ["paragraph:0:c", "paragraph:0:a", "paragraph:0:b"]);
  });

  test("dropping onto itself is a no-op", () => {
    const doc = [b("paragraph", "a"), b("paragraph", "b")];
    assert.equal(moveBlocks(doc, [doc[0].id], 0), null);
    assert.equal(moveBlocks(doc, [doc[0].id], 1), null);
  });

  test("dropping between a parent and its first child nests the block", () => {
    const doc = [b("bulleted", "parent"), b("bulleted", "child", { depth: 1 }), b("paragraph", "loose")];
    assert.equal(dropDepth(doc, 1), 1);
    assert.deepEqual(sketch(moveBlocks(doc, [doc[2].id], 1)!.blocks), [
      "bulleted:0:parent",
      "paragraph:1:loose",
      "bulleted:1:child",
    ]);
  });

  test("Mod+Shift+arrows swap a block with its sibling, children travelling along", () => {
    const doc = [b("bulleted", "a"), b("bulleted", "b"), b("bulleted", "b1", { depth: 1 }), b("bulleted", "c")];
    assert.deepEqual(sketch(moveBlocksBy(doc, [doc[1].id], -1)!.blocks), [
      "bulleted:0:b",
      "bulleted:1:b1",
      "bulleted:0:a",
      "bulleted:0:c",
    ]);
    assert.deepEqual(sketch(moveBlocksBy(doc, [doc[1].id], 1)!.blocks), [
      "bulleted:0:a",
      "bulleted:0:c",
      "bulleted:0:b",
      "bulleted:1:b1",
    ]);
    assert.equal(moveBlocksBy(doc, [doc[0].id], -1), null);
    assert.equal(moveBlocksBy(doc, [doc[3].id], 1), null);
  });

  test("selectionSpan covers the last block's children", () => {
    const doc = [b("bulleted", "a"), b("bulleted", "a1", { depth: 1 }), b("paragraph", "b")];
    assert.deepEqual(selectionSpan(doc, [doc[0].id]), [0, 2]);
    assert.equal(selectionSpan(doc, ["missing"]), null);
  });
});

describe("delete, duplicate, turn into", () => {
  test("deleting blocks removes their children and focuses the block above", () => {
    const doc = [b("paragraph", "keep"), b("bulleted", "drop"), b("bulleted", "child", { depth: 1 }), b("paragraph", "after")];
    const result = deleteBlocks(doc, [doc[1].id]);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:keep", "paragraph:0:after"]);
    assert.deepEqual(result.focus, { id: doc[0].id, start: 4 });
  });

  test("deleting everything leaves one empty paragraph", () => {
    const doc = [b("paragraph", "a")];
    const result = deleteBlocks(doc, [doc[0].id]);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:"]);
  });

  test("duplicate copies blocks and children right after, without their source", () => {
    const parsed = parseDoc("- a\n  - b").blocks;
    const result = duplicateBlocks(parsed, [parsed[0].id]);
    assert.deepEqual(sketch(result.blocks), ["bulleted:0:a", "bulleted:1:b", "bulleted:0:a", "bulleted:1:b"]);
    assert.equal(result.blocks[2].origin, undefined);
    assert.notEqual(result.blocks[2].id, parsed[0].id);
    assert.deepEqual(result.select, [result.blocks[2].id]);
  });

  test("turn into keeps the text", () => {
    const doc = [b("paragraph", "Make me")];
    for (const [kind, expected] of [
      ["h1", "headingh1:0:Make me"],
      ["h3", "headingh3:0:Make me"],
      ["bulleted", "bulleted:0:Make me"],
      ["todo", "todo[ ]:0:Make me"],
      ["quote", "quote:0:Make me"],
      ["callout", "callout:0:Make me"],
      ["toggle", "toggle:0:Make me"],
      ["code", "code:0:Make me"],
    ] as const) {
      assert.deepEqual(sketch(turnInto(doc, [doc[0].id], kind).blocks), [expected]);
    }
  });

  test("turning code into text keeps its lines; text into code drops formatting", () => {
    const code = [createBlock("code", { text: "a\nb", lang: "js" })];
    const asText = turnInto(code, [code[0].id], "paragraph").blocks[0];
    assert.equal(asText.type, "paragraph");
    assert.equal(plainText(asText.runs), "a\nb");
    assert.equal(asText.lang, undefined);
    const bold = [createBlock("paragraph", { runs: [{ text: "x", bold: true }] })];
    assert.equal(turnInto(bold, [bold[0].id], "code").blocks[0].text, "x");
  });

  test("turning a parent into text flattens its children rather than hiding them", () => {
    const doc = [b("bulleted", "parent"), b("bulleted", "child", { depth: 1 })];
    assert.deepEqual(sketch(turnInto(doc, [doc[0].id], "paragraph").blocks), ["paragraph:0:parent", "bulleted:0:child"]);
  });

  test("dividers and images can't be turned into text", () => {
    const doc = [b("divider")];
    assert.deepEqual(sketch(turnInto(doc, [doc[0].id], "paragraph").blocks), ["divider:0:"]);
  });

  test("kindOf names each block's kind", () => {
    assert.equal(kindOf(b("heading", "", { level: 2 })), "h2");
    assert.equal(kindOf(b("todo")), "todo");
    assert.equal(kindOf(b("divider")), null);
  });
});

describe("toggles and visibility", () => {
  test("a closed toggle hides its children from navigation", () => {
    const doc = [b("toggle", "t", { open: false }), b("paragraph", "hidden", { depth: 1 }), b("paragraph", "shown")];
    assert.deepEqual(visibility(doc), [true, false, true]);
    assert.equal(nextVisible(doc, 0), 2);
    assert.equal(previousVisible(doc, 2), 0);
    const opened = setToggleOpen(doc, doc[0].id, true);
    assert.deepEqual(visibility(opened), [true, true, true]);
  });

  test("blockRange selects visible blocks between two ends, in either order", () => {
    const doc = [b("paragraph", "a"), b("toggle", "t", { open: false }), b("paragraph", "h", { depth: 1 }), b("paragraph", "c")];
    assert.deepEqual(blockRange(doc, doc[3].id, doc[0].id), [doc[0].id, doc[1].id, doc[3].id]);
  });
});

describe("inserting", () => {
  test("+ adds an empty paragraph after a block and its children", () => {
    const doc = [b("bulleted", "a"), b("bulleted", "a1", { depth: 1 }), b("paragraph", "b")];
    const result = insertBlockBelow(doc, doc[0].id);
    assert.deepEqual(sketch(result.blocks), ["bulleted:0:a", "bulleted:1:a1", "paragraph:0:", "paragraph:0:b"]);
    assert.equal(result.focus?.id, result.blocks[2].id);
  });

  test("Alt-click on + adds above", () => {
    const doc = [b("paragraph", "a")];
    assert.deepEqual(sketch(insertBlockAbove(doc, doc[0].id).blocks), ["paragraph:0:", "paragraph:0:a"]);
  });

  test("leaving a code block opens a paragraph after it", () => {
    const doc = [createBlock("code", { text: "x" })];
    assert.deepEqual(sketch(insertParagraphAfter(doc, doc[0].id).blocks), ["code:0:x", "paragraph:0:"]);
  });

  test("ensureBlocks gives an empty page one paragraph", () => {
    assert.deepEqual(sketch(ensureBlocks([])), ["paragraph:0:"]);
  });
});

describe("ordinalLabel", () => {
  test("counts 1., a., i. by depth", () => {
    assert.equal(ordinalLabel(3, 0), "3.");
    assert.equal(ordinalLabel(0, 0), "0.");
    assert.equal(ordinalLabel(1, 1), "a.");
    assert.equal(ordinalLabel(26, 1), "z.");
    assert.equal(ordinalLabel(27, 1), "aa.");
    assert.equal(ordinalLabel(4, 2), "iv.");
    assert.equal(ordinalLabel(1994, 2), "mcmxciv.");
    assert.equal(ordinalLabel(2, 3), "2.");
  });
});

describe("reconcileBlocks", () => {
  test("blocks that survive an outside change keep their ids; new ones get their own", () => {
    const before = parseDoc("# Title\n\nFirst\n\nSecond").blocks;
    const after = parseDoc("# Title\n\nAdded by AI\n\nFirst\n\nSecond").blocks;
    const merged = reconcileBlocks(before, after);
    assert.equal(merged[0].id, before[0].id);
    assert.notEqual(merged[1].id, before[1].id);
    assert.equal(merged[2].id, before[1].id);
    assert.equal(merged[3].id, before[2].id);
  });

  test("an edited block keeps its id, so the caret stays in it", () => {
    const before = parseDoc("One\n\nTwo\n\nThree").blocks;
    const after = parseDoc("One\n\nTwo, edited elsewhere\n\nThree").blocks;
    const merged = reconcileBlocks(before, after);
    assert.deepEqual(merged.map((b) => b.id), before.map((b) => b.id));
    assert.equal(plainText(merged[1].runs), "Two, edited elsewhere");
  });

  test("keeps a toggle open that the person opened", () => {
    const before = parseDoc("<details>\n<summary>T</summary>\n\nx\n\n</details>").blocks;
    before[0] = { ...before[0], open: true };
    const after = parseDoc("<details>\n<summary>T</summary>\n\nx\n\n</details>\n\nmore").blocks;
    assert.equal(reconcileBlocks(before, after)[0].open, true);
  });

  test("the result is written from the new source, not the old one", () => {
    const before = parseDoc("Keep\n\nOld").blocks;
    const nextDoc = parseDoc("Keep\n\nNew text\n");
    const merged = reconcileBlocks(before, nextDoc.blocks);
    assert.equal(serializeDoc({ ...nextDoc, blocks: merged }), "Keep\n\nNew text\n");
  });
});

describe("pasteBlocks", () => {
  test("one pasted paragraph goes inline at the caret", () => {
    const doc = [b("paragraph", "Hello world")];
    const result = pasteBlocks(doc, doc[0].id, 6, 6, [b("paragraph", "big ")]);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:Hello big world"]);
    assert.deepEqual(result.focus, { id: doc[0].id, start: 10 });
  });

  test("one pasted paragraph replaces the selection", () => {
    const doc = [b("paragraph", "Hello world")];
    assert.deepEqual(sketch(pasteBlocks(doc, doc[0].id, 6, 11, [b("paragraph", "there")]).blocks), ["paragraph:0:Hello there"]);
  });

  test("several blocks split the current one and land between its halves", () => {
    const doc = [b("paragraph", "before|after")];
    const result = pasteBlocks(doc, doc[0].id, 7, 7, [b("heading", "Title", { level: 2 }), b("bulleted", "item")]);
    assert.deepEqual(sketch(result.blocks), ["paragraph:0:before|", "headingh2:0:Title", "bulleted:0:item", "paragraph:0:after"]);
    assert.equal(result.focus?.id, result.blocks[2].id);
  });

  test("pasting into an empty block replaces it", () => {
    const doc = [b("paragraph", "")];
    const result = pasteBlocks(doc, doc[0].id, 0, 0, [b("heading", "A", { level: 1 }), b("paragraph", "B")]);
    assert.deepEqual(sketch(result.blocks), ["headingh1:0:A", "paragraph:0:B"]);
  });

  test("pasted blocks sit at the current nesting level", () => {
    const doc = [b("bulleted", "parent"), b("bulleted", "", { depth: 1 })];
    const pasted = parseDoc("- x\n  - y").blocks;
    const result = pasteBlocks(doc, doc[1].id, 0, 0, pasted);
    assert.deepEqual(sketch(result.blocks), ["bulleted:0:parent", "bulleted:1:x", "bulleted:2:y"]);
  });

  test("pasted blocks are fresh: new ids and no source to write back verbatim", () => {
    const pasted = parseDoc("*  odd marker").blocks;
    const doc = [b("paragraph", "")];
    const result = pasteBlocks(doc, doc[0].id, 0, 0, [...pasted, b("paragraph", "x")]);
    assert.equal(result.blocks[0].origin, undefined);
    assert.equal(serializeDoc({ blocks: result.blocks, leading: "", trailing: "", segments: 0 }), "- odd marker\n\nx");
  });
});
