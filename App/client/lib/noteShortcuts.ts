/**
 * Markdown typed into the Notes editor turns into formatting as you type, the
 * way Notion does it: `# ` at the start of a line makes a heading, `- ` a
 * bulleted list, `**word**` bold. These are the pure matchers; the editor
 * calls them on each input and applies what they return.
 */

import {
  deleteRange,
  type MarkName,
  plainText,
  type Run,
  setMark,
  sliceRuns,
} from "./noteInline.js";
import type { BlockKind } from "./noteBlocks.js";

export type BlockShortcut =
  | { kind: BlockKind; consumed: number; level?: number; checked?: boolean; start?: number; lang?: string }
  | { kind: "divider"; consumed: number };

/**
 * A block shortcut typed at the start of a block, judged on the text before
 * the caret. `blockType` is what the block is now: most shortcuts apply to a
 * plain paragraph only, but `[] ` also turns a bulleted item into a to-do.
 */
export function matchBlockShortcut(beforeCaret: string, blockType: string): BlockShortcut | null {
  if (blockType === "bulleted") {
    const task = /^\[([ xX]?)\] $/.exec(beforeCaret);
    if (task) return { kind: "todo", consumed: task[0].length, checked: task[1].toLowerCase() === "x" };
    return null;
  }
  if (blockType !== "paragraph") return null;
  const heading = /^(#{1,3}) $/.exec(beforeCaret);
  if (heading) {
    const level = heading[1].length;
    return { kind: `h${level}` as BlockKind, consumed: heading[0].length, level };
  }
  const todo = /^(?:[-*+] )?\[([ xX]?)\] $/.exec(beforeCaret);
  if (todo) return { kind: "todo", consumed: todo[0].length, checked: todo[1].toLowerCase() === "x" };
  if (/^[-*+] $/.test(beforeCaret)) return { kind: "bulleted", consumed: 2 };
  const ordered = /^(\d{1,9})[.)] $/.exec(beforeCaret);
  if (ordered) return { kind: "numbered", consumed: ordered[0].length, start: Number(ordered[1]) };
  if (/^[>"] $/.test(beforeCaret)) return { kind: "quote", consumed: 2 };
  if (beforeCaret === "```") return { kind: "code", consumed: 3, lang: "" };
  const fenced = /^```([\w+#.-]{1,24}) $/.exec(beforeCaret);
  if (fenced) return { kind: "code", consumed: fenced[0].length, lang: fenced[1] };
  if (/^(?:---|\*\*\*|___)$/.test(beforeCaret)) return { kind: "divider", consumed: 3 };
  return null;
}

type InlineRule = { open: string; close: string; mark: MarkName };

// Longer delimiters first, so `**` wins over `*`.
const INLINE_RULES: InlineRule[] = [
  { open: "**", close: "**", mark: "bold" },
  { open: "__", close: "__", mark: "bold" },
  { open: "~~", close: "~~", mark: "strike" },
  { open: "`", close: "`", mark: "code" },
  { open: "*", close: "*", mark: "italic" },
  { open: "_", close: "_", mark: "italic" },
];

export type InlineShortcut = {
  runs: Run[];
  /** Where the caret goes: right after the newly formatted text. */
  caret: number;
  mark: MarkName;
};

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * The character just typed (before `caret`) closes a Markdown span —
 * `**bold**`, `*italic*`, `~~struck~~`, `` `code` `` — so strip the
 * delimiters and format what they held. Only plain text counts: delimiters
 * already inside code, or around nothing, don't fire.
 */
export function applyInlineShortcut(runs: readonly Run[], caret: number): InlineShortcut | null {
  const text = plainText(runs);
  if (caret <= 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  for (const rule of INLINE_RULES) {
    if (!before.endsWith(rule.close)) continue;
    const closeStart = caret - rule.close.length;
    // A longer delimiter of the same character is someone else's rule.
    const charBeforeClose = text[closeStart - 1];
    if (rule.close.length === 1 && charBeforeClose === rule.close) continue;
    const openStart = before.lastIndexOf(rule.open, closeStart - 1);
    if (openStart < 0) continue;
    const innerStart = openStart + rule.open.length;
    if (innerStart >= closeStart) continue;
    const inner = text.slice(innerStart, closeStart);
    if (/^\s|\s$/.test(inner) || inner.includes("\n")) continue;
    if (rule.open.length === 1 && text[openStart - 1] === rule.open) continue;
    if (rule.open.length === 1 && inner.startsWith(rule.open)) continue;
    // `_` never fires inside a word (snake_case_names).
    if (rule.open[0] === "_" && (isWordChar(text[openStart - 1]) || isWordChar(text[caret]))) continue;
    const span = sliceRuns(runs, openStart, caret);
    if (span.some((r) => r.code || r.raw)) continue;
    let next = deleteRange(runs, closeStart, caret);
    next = deleteRange(next, openStart, innerStart);
    const innerEnd = openStart + inner.length;
    next = setMark(next, openStart, innerEnd, rule.mark, true);
    return { runs: next, caret: innerEnd, mark: rule.mark };
  }
  return null;
}
