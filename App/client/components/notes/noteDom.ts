/**
 * The DOM side of the Notes editor: drawing runs into a contenteditable,
 * reading them back after the browser edits it, and moving the caret by
 * plain-text offset. Line breaks inside a block are "\n" characters in a
 * `white-space: pre-wrap` element; a trailing `<br data-trailing>` keeps a
 * final empty line visible and is never read as text.
 */

import { normalizeRuns, type Run, type RunFormat } from "../../lib/noteInline";

function wrap(node: Node, tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.appendChild(node);
  return el;
}

/** Replace the element's contents with the runs. */
export function renderRuns(el: HTMLElement, runs: readonly Run[]): void {
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    let node: Node = document.createTextNode(run.text);
    if (run.raw) node = wrap(node, "span", { "data-raw": "" });
    if (run.code) node = wrap(node, "code");
    if (run.italic) node = wrap(node, "em");
    if (run.bold) node = wrap(node, "strong");
    if (run.strike) node = wrap(node, "s");
    if (run.href !== undefined) {
      const attrs: Record<string, string> = { href: run.href, rel: "noreferrer noopener", target: "_blank" };
      if (run.title) attrs.title = run.title;
      if (run.autolink) attrs["data-autolink"] = run.autolink;
      node = wrap(node, "a", attrs);
    }
    fragment.appendChild(node);
  }
  const text = runs.map((r) => r.text).join("");
  if (text.endsWith("\n")) {
    const br = document.createElement("br");
    br.setAttribute("data-trailing", "");
    fragment.appendChild(br);
  }
  el.replaceChildren(fragment);
}

/** Replace the element's contents with plain text (code, raw Markdown). */
export function renderPlain(el: HTMLElement, text: string): void {
  const fragment = document.createDocumentFragment();
  if (text) fragment.appendChild(document.createTextNode(text));
  if (text.endsWith("\n")) {
    const br = document.createElement("br");
    br.setAttribute("data-trailing", "");
    fragment.appendChild(br);
  }
  el.replaceChildren(fragment);
}

function isTrailingBreak(node: Node, root: HTMLElement): boolean {
  if (node.nodeName !== "BR") return false;
  if ((node as Element).hasAttribute?.("data-trailing")) return true;
  // A <br> the browser leaves as the last thing in an emptied editable is a
  // placeholder, not a line break.
  let cursor: Node | null = node;
  while (cursor && cursor !== root) {
    if (cursor.nextSibling) return false;
    cursor = cursor.parentNode;
  }
  return true;
}

function formatFor(el: Element, base: RunFormat): RunFormat {
  const tag = el.tagName;
  const next: RunFormat = { ...base };
  if (tag === "STRONG" || tag === "B") next.bold = true;
  if (tag === "EM" || tag === "I") next.italic = true;
  if (tag === "S" || tag === "DEL" || tag === "STRIKE") next.strike = true;
  if (tag === "CODE") next.code = true;
  if (tag === "SPAN" && el.hasAttribute("data-raw")) next.raw = true;
  if (tag === "A") {
    const href = el.getAttribute("href");
    if (href) {
      next.href = href;
      const title = el.getAttribute("title");
      if (title) next.title = title;
      const autolink = el.getAttribute("data-autolink");
      if (autolink === "angle" || autolink === "bare") next.autolink = autolink;
    }
  }
  const style = (el as HTMLElement).style;
  if (style) {
    const weight = style.fontWeight;
    if (weight === "bold" || Number(weight) >= 600) next.bold = true;
    if (style.fontStyle === "italic") next.italic = true;
    if (style.textDecorationLine?.includes("line-through") || style.textDecoration?.includes("line-through")) {
      next.strike = true;
    }
  }
  return next;
}

/** Read the runs back out of an element the browser has edited. */
export function readRuns(root: HTMLElement): Run[] {
  const out: Run[] = [];
  const walk = (node: Node, format: RunFormat) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.nodeValue ?? "").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
        if (text) out.push({ ...format, text });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.tagName === "BR") {
          if (!isTrailingBreak(el, root)) out.push({ ...format, text: "\n" });
          continue;
        }
        const block = el.tagName === "DIV" || el.tagName === "P";
        if (block && out.length > 0 && !out[out.length - 1].text.endsWith("\n")) out.push({ ...format, text: "\n" });
        walk(el, formatFor(el, format));
      }
    }
  };
  walk(root, {});
  return normalizeRuns(out);
}

/** Plain text of an edited plain-text element. */
export function readPlain(root: HTMLElement): string {
  return readRuns(root)
    .map((r) => r.text)
    .join("");
}

function nodeLength(node: Node, root: HTMLElement): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? "").replace(/\u200b/g, "").length;
  if (node.nodeName === "BR") return isTrailingBreak(node, root) ? 0 : 1;
  let n = 0;
  for (const child of Array.from(node.childNodes)) n += nodeLength(child, root);
  return n;
}

/** Plain-text offset of a DOM position inside `root`. */
export function offsetOf(root: HTMLElement, node: Node, nodeOffset: number): number {
  if (!root.contains(node)) return 0;
  let total = 0;
  const visit = (current: Node): boolean => {
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) {
        total += Math.min(nodeOffset, (current.nodeValue ?? "").length);
      } else {
        const children = Array.from(current.childNodes);
        for (let i = 0; i < Math.min(nodeOffset, children.length); i++) total += nodeLength(children[i], root);
      }
      return true;
    }
    if (current.nodeType === Node.TEXT_NODE || current.nodeName === "BR") {
      total += nodeLength(current, root);
      return false;
    }
    for (const child of Array.from(current.childNodes)) if (visit(child)) return true;
    return false;
  };
  for (const child of Array.from(root.childNodes)) if (visit(child)) return total;
  return node === root ? total : total;
}

/** The selection inside `root` as plain-text offsets, or null when it isn't there. */
export function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const a = offsetOf(root, range.startContainer, range.startOffset);
  const b = offsetOf(root, range.endContainer, range.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function positionAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = Math.max(0, offset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let lastText: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = (node.nodeValue ?? "").length;
      lastText = node as Text;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
    } else if (node.nodeName === "BR" && !isTrailingBreak(node, root)) {
      if (remaining === 0) {
        const parent = node.parentNode!;
        return { node: parent, offset: Array.from(parent.childNodes).indexOf(node as ChildNode) };
      }
      remaining -= 1;
      if (remaining === 0) {
        const parent = node.parentNode!;
        return { node: parent, offset: Array.from(parent.childNodes).indexOf(node as ChildNode) + 1 };
      }
    }
  }
  if (lastText) return { node: lastText, offset: (lastText.nodeValue ?? "").length };
  return { node: root, offset: 0 };
}

/** Put the caret (or a selection) at plain-text offsets inside `root`. */
export function setSelectionOffsets(root: HTMLElement, start: number, end: number = start): void {
  const selection = window.getSelection();
  if (!selection) return;
  const a = positionAt(root, start);
  const b = end === start ? a : positionAt(root, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Where the caret is on screen, for anchoring menus. */
export function caretRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const rects = range.getClientRects();
    if (rects.length > 0) rect = rects[0];
    else {
      const node = range.startContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (el) rect = el.getBoundingClientRect();
    }
  }
  return rect;
}

/** Is the caret on the first visual line of `root`? (Up arrow leaves the block then.) */
export function caretOnFirstLine(root: HTMLElement): boolean {
  const caret = caretRect();
  if (!caret || (caret.top === 0 && caret.bottom === 0)) return true;
  const box = root.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(root).lineHeight) || 24;
  return caret.top - box.top < lineHeight * 0.8;
}

/** Is the caret on the last visual line of `root`? (Down arrow leaves the block then.) */
export function caretOnLastLine(root: HTMLElement): boolean {
  const caret = caretRect();
  if (!caret || (caret.top === 0 && caret.bottom === 0)) return true;
  const box = root.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(root).lineHeight) || 24;
  return box.bottom - caret.bottom < lineHeight * 0.8;
}

/** Plain-text offset nearest to a horizontal position on the first or last line of `root`. */
export function offsetAtX(root: HTMLElement, x: number, line: "first" | "last"): number | null {
  const box = root.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(root).lineHeight) || 24;
  const y = line === "first" ? box.top + lineHeight / 2 : box.bottom - lineHeight / 2;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos && root.contains(pos.offsetNode)) return offsetOf(root, pos.offsetNode, pos.offset);
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range && root.contains(range.startContainer)) return offsetOf(root, range.startContainer, range.startOffset);
  }
  return null;
}
