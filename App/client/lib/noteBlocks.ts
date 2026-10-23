/**
 * The Notes editor's operations, as pure functions over a flat list of
 * blocks. Each takes the current blocks and returns new ones plus where the
 * caret (or block selection) should land, so every Enter, Backspace, Tab,
 * drag and paste can be tested without a browser.
 *
 * Nesting follows Markdown: a block may sit one level under a list item or a
 * toggle, never under a paragraph — that is what the saved Markdown can say.
 * `normalizeDepths` enforces it after every structural change.
 */

import {
  concatRuns,
  deleteRange,
  plainText,
  type Run,
  runsLength,
  splitRuns,
  textRuns,
} from "./noteInline.js";
import {
  type Block,
  type BlockType,
  type CalloutKind,
  isContainer,
  isListItem,
  isPlainText,
  isRichText,
  newBlockId,
  subtreeEnd,
} from "./noteMarkdown.js";

/** Where the caret goes after an operation: a block and a text range in it. */
export type Focus = { id: string; start: number; end?: number };

export type EditResult = {
  blocks: Block[];
  focus?: Focus;
  /** Blocks to leave selected as whole blocks (block selection). */
  select?: string[];
};

/** What "turn into" and the slash menu can make a block. */
export type BlockKind =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "bulleted"
  | "numbered"
  | "todo"
  | "toggle"
  | "quote"
  | "callout"
  | "code";

export function createBlock(type: BlockType, extra: Partial<Block> = {}): Block {
  const block: Block = { id: newBlockId(), type, depth: 0, runs: [], text: "", ...extra };
  if (type === "todo" && block.checked === undefined) block.checked = false;
  if (type === "toggle" && block.open === undefined) block.open = true;
  if (type === "callout" && block.kind === undefined) block.kind = "tip";
  if (type === "heading" && block.level === undefined) block.level = 1;
  return block;
}

/** The kind a block currently is, in "turn into" terms. */
export function kindOf(block: Block): BlockKind | null {
  switch (block.type) {
    case "heading":
      return block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
    case "paragraph":
    case "bulleted":
    case "numbered":
    case "todo":
    case "toggle":
    case "quote":
    case "callout":
    case "code":
      return block.type;
    default:
      return null;
  }
}

export function indexOfBlock(blocks: readonly Block[], id: string): number {
  return blocks.findIndex((b) => b.id === id);
}

/** Keep every block's depth one that Markdown can express. */
export function normalizeDepths(blocks: readonly Block[]): Block[] {
  let changed = false;
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const prev = out[i - 1];
    const max = prev ? (isContainer(prev) ? prev.depth + 1 : prev.depth) : 0;
    const depth = Math.max(0, Math.min(block.depth, max));
    if (depth !== block.depth) {
      out.push({ ...block, depth });
      changed = true;
    } else {
      out.push(block);
    }
  }
  return changed ? out : (blocks as Block[]);
}

/** There is always a block to type in. */
export function ensureBlocks(blocks: readonly Block[]): Block[] {
  return blocks.length > 0 ? (blocks as Block[]) : [createBlock("paragraph")];
}

/** Which blocks are shown: everything but the children of closed toggles. */
export function visibility(blocks: readonly Block[]): boolean[] {
  const out: boolean[] = [];
  let hiddenBelow = Infinity;
  for (const block of blocks) {
    if (block.depth <= hiddenBelow) hiddenBelow = Infinity;
    out.push(hiddenBelow === Infinity);
    if (hiddenBelow === Infinity && block.type === "toggle" && !block.open) hiddenBelow = block.depth;
  }
  return out;
}

export function previousVisible(blocks: readonly Block[], index: number): number {
  const shown = visibility(blocks);
  for (let i = index - 1; i >= 0; i--) if (shown[i]) return i;
  return -1;
}

export function nextVisible(blocks: readonly Block[], index: number): number {
  const shown = visibility(blocks);
  for (let i = index + 1; i < blocks.length; i++) if (shown[i]) return i;
  return -1;
}

/** The block type a new block continues as after Enter. */
function continuation(block: Block): BlockType {
  if (isListItem(block)) return block.type;
  return "paragraph";
}

function stripTypeAttributes(block: Block): Block {
  const next: Block = { ...block };
  delete next.level;
  delete next.checked;
  delete next.start;
  delete next.lang;
  delete next.kind;
  delete next.open;
  return next;
}

/** Does the block at `index` have children shown under it? */
function hasVisibleChildren(blocks: readonly Block[], index: number): boolean {
  const block = blocks[index];
  const next = blocks[index + 1];
  if (!next || next.depth <= block.depth) return false;
  return block.type !== "toggle" || Boolean(block.open);
}

function replaceAt(blocks: readonly Block[], index: number, ...items: Block[]): Block[] {
  const out = blocks.slice();
  out.splice(index, 1, ...items);
  return out;
}

function insertAt(blocks: readonly Block[], index: number, ...items: Block[]): Block[] {
  const out = blocks.slice();
  out.splice(index, 0, ...items);
  return out;
}

/** Shift a block and its subtree by `delta` levels. */
function shiftSubtree(blocks: readonly Block[], index: number, delta: number): Block[] {
  const end = subtreeEnd(blocks, index);
  return blocks.map((b, i) => (i >= index && i < end ? { ...b, depth: Math.max(0, b.depth + delta) } : b));
}

// ───────────────────────── Enter ────────────────────────────────────────────

/**
 * Enter in a rich-text block, with `[start, end)` selected. Splits the block
 * the way Notion does: an empty list item steps out (outdents, then becomes
 * text), Enter at the start of a line opens an empty block above, and a block
 * with children shown starts its first child.
 */
export function splitBlock(
  blocks: readonly Block[],
  id: string,
  start: number,
  end: number = start,
): EditResult {
  const index = indexOfBlock(blocks, id);
  if (index < 0) return { blocks: blocks as Block[] };
  const block = blocks[index];
  const runs = deleteRange(block.runs, start, end);
  const empty = plainText(runs) === "";

  if (empty && (isListItem(block) || block.type === "quote" || block.type === "callout" || block.type === "toggle")) {
    if (isListItem(block) && block.depth > 0) {
      const shifted = shiftSubtree(blocks, index, -1);
      return { blocks: normalizeDepths(shifted), focus: { id, start: 0 } };
    }
    const turned = { ...stripTypeAttributes(block), type: "paragraph" as const, runs };
    return { blocks: normalizeDepths(replaceAt(blocks, index, turned)), focus: { id, start: 0 } };
  }

  if (start === 0 && !empty) {
    const above = createBlock(continuation(block), { depth: block.depth });
    const updated = runs === block.runs ? block : { ...block, runs };
    return {
      blocks: insertAt(replaceAt(blocks, index, updated), index, above),
      focus: { id, start: 0 },
    };
  }

  const [left, right] = splitRuns(runs, start);
  const updated: Block = { ...block, runs: left };
  if (hasVisibleChildren(blocks, index) || (block.type === "toggle" && block.open)) {
    const childType: BlockType = block.type === "toggle" ? "paragraph" : continuation(block);
    const child = createBlock(childType, { depth: block.depth + 1, runs: right });
    return {
      blocks: insertAt(replaceAt(blocks, index, updated), index + 1, child),
      focus: { id: child.id, start: 0 },
    };
  }
  const after = subtreeEnd(blocks, index);
  const type: BlockType = block.type === "toggle" ? "toggle" : continuation(block);
  const fresh = createBlock(type, {
    depth: block.depth,
    runs: right,
    ...(type === "toggle" ? { open: false } : {}),
  });
  return {
    blocks: insertAt(replaceAt(blocks, index, updated), after, fresh),
    focus: { id: fresh.id, start: 0 },
  };
}

/** Mod+Enter in a code block, or Enter past a non-text block: a paragraph after it. */
export function insertParagraphAfter(blocks: readonly Block[], id: string): EditResult {
  const index = indexOfBlock(blocks, id);
  if (index < 0) return { blocks: blocks as Block[] };
  const block = blocks[index];
  const fresh = createBlock("paragraph", { depth: block.depth });
  const at = block.type === "toggle" && !block.open ? subtreeEnd(blocks, index) : index + 1;
  return { blocks: normalizeDepths(insertAt(blocks, at, fresh)), focus: { id: fresh.id, start: 0 } };
}

/** The `+` beside a block: a new empty paragraph after it and its children, at its level. */
export function insertBlockBelow(blocks: readonly Block[], id: string, type: BlockType = "paragraph"): EditResult {
  const index = indexOfBlock(blocks, id);
  if (index < 0) return { blocks: blocks as Block[] };
  const block = blocks[index];
  const fresh = createBlock(type, { depth: block.depth });
  return {
    blocks: normalizeDepths(insertAt(blocks, subtreeEnd(blocks, index), fresh)),
    focus: { id: fresh.id, start: 0 },
  };
}

/** Alt-click on `+`: a new empty paragraph above the block. */
export function insertBlockAbove(blocks: readonly Block[], id: string): EditResult {
  const index = indexOfBlock(blocks, id);
  if (index < 0) return { blocks: blocks as Block[] };
  const fresh = createBlock("paragraph", { depth: blocks[index].depth });
  return { blocks: normalizeDepths(insertAt(blocks, index, fresh)), focus: { id: fresh.id, start: 0 } };
}

// ───────────────────────── Backspace / Delete ───────────────────────────────

/**
 * Backspace with the caret at the very start of a block. A styled block
 * becomes text first, a nested block steps out next, and only then does a
 * block merge into the one above — Notion's order.
 */
export function backspaceAtStart(blocks: readonly Block[], id: string): EditResult {
  const index = indexOfBlock(blocks, id);
  if (index < 0) return { blocks: blocks as Block[] };
  const block = blocks[index];

  if (isRichText(block.type) && block.type !== "paragraph") {
    const turned = { ...stripTypeAttributes(block), type: "paragraph" as const };
    return { blocks: normalizeDepths(replaceAt(blocks, index, turned)), focus: { id, start: 0 } };
  }
  if (isPlainText(block.type)) {
    if (block.text !== "") return { blocks: blocks as Block[] };
    const turned = { ...stripTypeAttributes(block), type: "paragraph" as const, text: "", runs: [] };
    return { blocks: replaceAt(blocks, index, turned), focus: { id, start: 0 } };
  }
  if (block.depth > 0) {
    return { blocks: normalizeDepths(shiftSubtree(blocks, index, -1)), focus: { id, start: 0 } };
  }

  const prevIndex = previousVisible(blocks, index);
  if (prevIndex < 0) return { blocks: blocks as Block[] };
  const prev = blocks[prevIndex];
  if (prev.type === "divider" || prev.type === "image") {
    const out = blocks.slice();
    out.splice(prevIndex, 1);
    return { blocks: normalizeDepths(out), focus: { id, start: 0 } };
  }
  if (isPlainText(prev.type)) {
    const text = plainText(block.runs);
    const out = blocks.slice();
    out.splice(index, 1);
    if (text === "") {
      return { blocks: normalizeDepths(out), focus: { id: prev.id, start: prev.text.length } };
    }
    const joined = prev.text === "" ? text : `${prev.text}\n${text}`;
    out[prevIndex] = { ...prev, text: joined };
    return {
      blocks: normalizeDepths(out),
      focus: { id: prev.id, start: prev.text === "" ? 0 : prev.text.length + 1 },
    };
  }
  const at = runsLength(prev.runs);
  const merged: Block = { ...prev, runs: concatRuns(prev.runs, block.runs) };
  const out = blocks.slice();
  out[prevIndex] = merged;
  out.splice(index, 1);
  return { blocks: normalizeDepths(out), focus: { id: prev.id, start: at } };
}

/** Delete (forward) with the caret at the very end of a block: pull the next block up into it. */
export function deleteAtEnd(blocks: readonly Block[], id: string): EditResult {
  const index = indexOfBlock(blocks, id);
  if (index < 0) return { blocks: blocks as Block[] };
  const block = blocks[index];
  const nextIndex = nextVisible(blocks, index);
  if (nextIndex < 0) return { blocks: blocks as Block[] };
  const next = blocks[nextIndex];
  const caret = isRichText(block.type) ? runsLength(block.runs) : block.text.length;
  if (next.type === "divider" || next.type === "image") {
    const out = blocks.slice();
    out.splice(nextIndex, 1);
    return { blocks: normalizeDepths(out), focus: { id, start: caret } };
  }
  if (!isRichText(block.type) || !isRichText(next.type)) return { blocks: blocks as Block[] };
  const out = blocks.slice();
  out[index] = { ...block, runs: concatRuns(block.runs, next.runs) };
  out.splice(nextIndex, 1);
  return { blocks: normalizeDepths(out), focus: { id, start: caret } };
}

// ───────────────────────── Nesting ──────────────────────────────────────────

/** The contiguous range covering these blocks and the subtree of the last one. */
export function selectionSpan(blocks: readonly Block[], ids: readonly string[]): [number, number] | null {
  const indices = ids.map((id) => indexOfBlock(blocks, id)).filter((i) => i >= 0);
  if (indices.length === 0) return null;
  const first = Math.min(...indices);
  const last = Math.max(...indices);
  let end = subtreeEnd(blocks, last);
  for (let i = first; i <= last; i++) end = Math.max(end, subtreeEnd(blocks, i));
  return [first, end];
}

/** Tab: nest the blocks under the sibling above, when that sibling can hold children. */
export function indentBlocks(blocks: readonly Block[], ids: readonly string[]): EditResult | null {
  const span = selectionSpan(blocks, ids);
  if (!span) return null;
  const [start, end] = span;
  const depth = blocks[start].depth;
  let sibling = start - 1;
  while (sibling >= 0 && blocks[sibling].depth > depth) sibling--;
  if (sibling < 0 || blocks[sibling].depth !== depth || !isContainer(blocks[sibling])) return null;
  const out = blocks.map((b, i) => (i >= start && i < end ? { ...b, depth: b.depth + 1 } : b));
  if (out[sibling].type === "toggle" && !out[sibling].open) out[sibling] = { ...out[sibling], open: true };
  return { blocks: normalizeDepths(out) };
}

/** Shift+Tab: step the blocks out one level. */
export function outdentBlocks(blocks: readonly Block[], ids: readonly string[]): EditResult | null {
  const span = selectionSpan(blocks, ids);
  if (!span) return null;
  const [start, end] = span;
  if (blocks[start].depth === 0) return null;
  const out = blocks.map((b, i) => (i >= start && i < end ? { ...b, depth: Math.max(0, b.depth - 1) } : b));
  return { blocks: normalizeDepths(out) };
}

// ───────────────────────── Moving ───────────────────────────────────────────

/**
 * The depth a block dropped at `index` (between `blocks[index - 1]` and
 * `blocks[index]`) takes: the first child's level when dropped between a
 * parent and its children, otherwise the level of the block above.
 */
export function dropDepth(blocks: readonly Block[], index: number): number {
  const above = blocks[index - 1];
  const below = blocks[index];
  if (!above) return 0;
  if (below && below.depth > above.depth) return below.depth;
  return above.depth;
}

/**
 * Move the selected blocks (with their children) so they start at `target`,
 * an index into the current list, at `depth`.
 */
export function moveBlocks(
  blocks: readonly Block[],
  ids: readonly string[],
  target: number,
  depth: number = dropDepth(blocks, target),
): EditResult | null {
  const span = selectionSpan(blocks, ids);
  if (!span) return null;
  const [start, end] = span;
  if (target >= start && target <= end) {
    if (depth === blocks[start].depth) return null;
    if (target !== start && target !== end) return null;
  }
  const moved = blocks.slice(start, end);
  const delta = depth - moved[0].depth;
  const shifted = moved.map((b) => ({ ...b, depth: Math.max(0, b.depth + delta) }));
  const rest = [...blocks.slice(0, start), ...blocks.slice(end)];
  const at = target > start ? Math.max(start, target - (end - start)) : target;
  const out = [...rest.slice(0, at), ...shifted, ...rest.slice(at)];
  return { blocks: normalizeDepths(out), select: moved.filter((b) => ids.includes(b.id)).map((b) => b.id) };
}

/** Mod+Shift+↑/↓: swap the selected blocks with their neighbouring sibling. */
export function moveBlocksBy(
  blocks: readonly Block[],
  ids: readonly string[],
  direction: -1 | 1,
): EditResult | null {
  const span = selectionSpan(blocks, ids);
  if (!span) return null;
  const [start, end] = span;
  const depth = blocks[start].depth;
  if (direction < 0) {
    let sibling = start - 1;
    while (sibling >= 0 && blocks[sibling].depth > depth) sibling--;
    if (sibling < 0 || blocks[sibling].depth !== depth) return null;
    const out = [...blocks.slice(0, sibling), ...blocks.slice(start, end), ...blocks.slice(sibling, start), ...blocks.slice(end)];
    return { blocks: normalizeDepths(out) };
  }
  const next = blocks[end];
  if (!next || next.depth !== depth) return null;
  const nextEnd = subtreeEnd(blocks, end);
  const out = [...blocks.slice(0, start), ...blocks.slice(end, nextEnd), ...blocks.slice(start, end), ...blocks.slice(nextEnd)];
  return { blocks: normalizeDepths(out) };
}

// ───────────────────────── Delete / duplicate / turn into ───────────────────

/** Remove the blocks and their children; the caret lands on the nearest block left. */
export function deleteBlocks(blocks: readonly Block[], ids: readonly string[]): EditResult {
  const span = selectionSpan(blocks, ids);
  if (!span) return { blocks: blocks as Block[] };
  const [start, end] = span;
  const out = [...blocks.slice(0, start), ...blocks.slice(end)];
  if (out.length === 0) {
    const fresh = createBlock("paragraph");
    return { blocks: [fresh], focus: { id: fresh.id, start: 0 } };
  }
  const normalized = normalizeDepths(out);
  const before = previousVisible(normalized, start);
  const target = before >= 0 ? normalized[before] : normalized[Math.min(start, normalized.length - 1)];
  const caret = isRichText(target.type) ? runsLength(target.runs) : target.text.length;
  if (!isRichText(target.type) && !isPlainText(target.type)) {
    return { blocks: normalized, select: [target.id] };
  }
  return { blocks: normalized, focus: { id: target.id, start: before >= 0 ? caret : 0 } };
}

function cloneBlock(block: Block): Block {
  const copy: Block = { ...block, id: newBlockId(), runs: block.runs.map((r) => ({ ...r })) };
  delete copy.origin;
  return copy;
}

/** Mod+D: copies of the blocks (and their children) right after them. */
export function duplicateBlocks(blocks: readonly Block[], ids: readonly string[]): EditResult {
  const span = selectionSpan(blocks, ids);
  if (!span) return { blocks: blocks as Block[] };
  const [start, end] = span;
  const copies = blocks.slice(start, end).map(cloneBlock);
  const roots = copies.filter((c) => c.depth === blocks[start].depth).map((c) => c.id);
  return { blocks: insertAt(blocks, end, ...copies), select: roots };
}

function turnOne(block: Block, kind: BlockKind): Block {
  if (block.type === "divider" || block.type === "image") return block;
  const fromPlain = isPlainText(block.type);
  const runs: Run[] = fromPlain ? textRuns(block.text) : block.runs;
  const base = stripTypeAttributes(block);
  switch (kind) {
    case "code":
      return {
        ...base,
        type: "code",
        runs: [],
        text: fromPlain ? block.text : plainText(block.runs),
        lang: block.type === "code" ? block.lang : "",
      };
    case "h1":
    case "h2":
    case "h3":
      return { ...base, type: "heading", level: Number(kind[1]), runs, text: "" };
    case "todo":
      return { ...base, type: "todo", runs, text: "", checked: block.type === "todo" ? block.checked : false };
    case "toggle":
      return { ...base, type: "toggle", runs, text: "", open: true };
    case "callout":
      return { ...base, type: "callout", runs, text: "", kind: block.kind ?? ("tip" as CalloutKind) };
    case "numbered":
      return { ...base, type: "numbered", runs, text: "" };
    default:
      return { ...base, type: kind, runs, text: "" };
  }
}

/** Change what the blocks are, keeping their text. */
export function turnInto(blocks: readonly Block[], ids: readonly string[], kind: BlockKind): EditResult {
  const set = new Set(ids);
  const out = blocks.map((b) => (set.has(b.id) ? turnOne(b, kind) : b));
  const first = out.find((b) => set.has(b.id));
  return {
    blocks: normalizeDepths(out),
    ...(first && ids.length === 1
      ? { focus: { id: first.id, start: isRichText(first.type) ? runsLength(first.runs) : first.text.length } }
      : { select: [...ids] }),
  };
}

export function setToggleOpen(blocks: readonly Block[], id: string, open: boolean): Block[] {
  return blocks.map((b) => (b.id === id ? { ...b, open } : b));
}

export function updateBlock(blocks: readonly Block[], id: string, patch: Partial<Block>): Block[] {
  return blocks.map((b) => (b.id === id ? { ...b, ...patch } : b));
}

// ───────────────────────── Paste ────────────────────────────────────────────

/**
 * Paste parsed blocks at the caret, Notion's way: one line of text goes
 * inline; several blocks split the current one, land between its halves,
 * and replace it outright when it was empty.
 */
export function pasteBlocks(
  blocks: readonly Block[],
  id: string,
  start: number,
  end: number,
  pasted: readonly Block[],
): EditResult {
  const index = indexOfBlock(blocks, id);
  if (index < 0 || pasted.length === 0) return { blocks: blocks as Block[] };
  const block = blocks[index];
  const fresh = pasted.map(cloneBlock);
  const minDepth = Math.min(...fresh.map((b) => b.depth));

  if (isRichText(block.type) && fresh.length === 1 && fresh[0].type === "paragraph") {
    const runs = concatRuns(splitRuns(block.runs, start)[0], fresh[0].runs, splitRuns(block.runs, end)[1]);
    return {
      blocks: replaceAt(blocks, index, { ...block, runs }),
      focus: { id, start: start + runsLength(fresh[0].runs) },
    };
  }

  const placed = fresh.map((b) => ({ ...b, depth: b.depth - minDepth + block.depth }));
  if (isPlainText(block.type)) {
    const out = insertAt(blocks, subtreeEnd(blocks, index), ...placed);
    const last = placed[placed.length - 1];
    return { blocks: normalizeDepths(out), focus: caretAtEnd(last) };
  }
  const runs = isRichText(block.type) ? block.runs : [];
  const [left] = splitRuns(runs, start);
  const [, right] = splitRuns(runs, end);
  const items: Block[] = [];
  const leftEmpty = plainText(left) === "";
  if (!leftEmpty || !isRichText(block.type)) items.push(isRichText(block.type) ? { ...block, runs: left } : block);
  items.push(...placed);
  if (plainText(right) !== "") {
    items.push(createBlock(continuation(block), { depth: block.depth, runs: right }));
  }
  const out = replaceAt(blocks, index, ...items);
  const last = placed[placed.length - 1];
  return { blocks: normalizeDepths(out), focus: caretAtEnd(last) };
}

function caretAtEnd(block: Block): Focus | undefined {
  if (isRichText(block.type)) return { id: block.id, start: runsLength(block.runs) };
  if (isPlainText(block.type)) return { id: block.id, start: block.text.length };
  return undefined;
}

/** The ids from `anchor` to `focus` (inclusive, either order), visible blocks only. */
export function blockRange(blocks: readonly Block[], anchor: string, focus: string): string[] {
  const a = indexOfBlock(blocks, anchor);
  const b = indexOfBlock(blocks, focus);
  if (a < 0 || b < 0) return [];
  const shown = visibility(blocks);
  const [from, to] = a <= b ? [a, b] : [b, a];
  const out: string[] = [];
  for (let i = from; i <= to; i++) if (shown[i]) out.push(blocks[i].id);
  return out;
}
