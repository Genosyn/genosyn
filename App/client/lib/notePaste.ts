/**
 * What lands in a note when something is pasted into it. Pasted HTML (a web
 * page, Google Docs, another note) becomes proper blocks — headings, lists,
 * to-dos, quotes, code, tables — and pasted Markdown is read as Markdown, so
 * a page copied from anywhere arrives as a page rather than a wall of text.
 *
 * HTML is converted from a small element tree. In the browser that tree is
 * read off `DOMParser`; `parseHtmlFragment` builds the same shape without a
 * DOM, which is what the tests use and what runs if `DOMParser` is missing.
 */

import {
  linkifyRuns,
  normalizeRuns,
  plainText,
  type Run,
  type RunFormat,
  serializeInline,
  textRuns,
} from "./noteInline.js";
import { type Block, isRichText, newBlockId, parseDoc } from "./noteMarkdown.js";
import { createBlock, normalizeDepths } from "./noteBlocks.js";

export type HtmlNode =
  | { type: "element"; tag: string; attrs: Record<string, string>; children: HtmlNode[] }
  | { type: "text"; text: string };

// ───────────────────────── A small HTML reader ──────────────────────────────

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
/** Opening one of these closes an open element of the listed tags first. */
const AUTO_CLOSE: Record<string, string[]> = {
  p: ["p"],
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  thead: ["tbody", "tfoot"],
  tbody: ["thead", "tbody", "tfoot"],
  h1: ["p"], h2: ["p"], h3: ["p"], h4: ["p"], h5: ["p"], h6: ["p"],
  ul: ["p"], ol: ["p"], pre: ["p"], blockquote: ["p"], table: ["p"], hr: ["p"], div: ["p"],
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•",
  middot: "·", times: "×", euro: "€", pound: "£", deg: "°", laquo: "«", raquo: "»",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Read an HTML fragment into an element tree, forgivingly: unclosed tags close themselves. */
export function parseHtmlFragment(html: string): HtmlNode {
  const root: HtmlNode = { type: "element", tag: "#root", attrs: {}, children: [] };
  const stack: Array<Extract<HtmlNode, { type: "element" }>> = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i] === "<" && (html[i + 1] === "!" || html[i + 1] === "?")) {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const tag = /^<(\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(i, i + 4000));
    if (tag) {
      i += tag[0].length;
      const name = tag[2].toLowerCase();
      if (tag[1] === "/") {
        const at = stack.map((e) => e.tag).lastIndexOf(name);
        if (at > 0) stack.length = at;
        continue;
      }
      for (const closes of AUTO_CLOSE[name] ?? []) {
        const at = stack.map((e) => e.tag).lastIndexOf(closes);
        // Only close within the nearest list/table, not across it.
        const boundary = Math.max(
          stack.map((e) => e.tag).lastIndexOf("ul"),
          stack.map((e) => e.tag).lastIndexOf("ol"),
          stack.map((e) => e.tag).lastIndexOf("table"),
        );
        if (at > 0 && (at > boundary || closes === "p")) stack.length = at;
      }
      const element: Extract<HtmlNode, { type: "element" }> = {
        type: "element",
        tag: name,
        attrs: parseAttributes(tag[3]),
        children: [],
      };
      top().children.push(element);
      if (RAW_TEXT_TAGS.has(name)) {
        const close = html.toLowerCase().indexOf(`</${name}`, i);
        const end = close < 0 ? html.length : close;
        element.children.push({ type: "text", text: decodeEntities(html.slice(i, end)) });
        const gt = close < 0 ? -1 : html.indexOf(">", close);
        i = gt < 0 ? html.length : gt + 1;
        continue;
      }
      if (!VOID_TAGS.has(name) && !/\/\s*$/.test(tag[3])) stack.push(element);
      continue;
    }
    const next = html.indexOf("<", i + 1);
    const end = next < 0 ? html.length : next;
    top().children.push({ type: "text", text: decodeEntities(html.slice(i, end)) });
    i = end;
  }
  return root;
}

/** The same tree, read off a real DOM node (the browser's `DOMParser`). */
export function htmlNodeFromDom(node: Node): HtmlNode {
  if (node.nodeType === 3) return { type: "text", text: node.nodeValue ?? "" };
  const element = node as Element;
  const attrs: Record<string, string> = {};
  if (element.attributes) {
    for (const attr of Array.from(element.attributes)) attrs[attr.name.toLowerCase()] = attr.value;
  }
  const children: HtmlNode[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 1 || child.nodeType === 3) children.push(htmlNodeFromDom(child));
  }
  return { type: "element", tag: (element.tagName ?? "#root").toLowerCase(), attrs, children };
}

// ───────────────────────── HTML → blocks ────────────────────────────────────

const SKIP_TAGS = new Set(["script", "style", "head", "title", "meta", "link", "noscript", "template", "button", "select", "option", "svg", "math"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "figure", "figcaption",
  "address", "center", "form", "fieldset", "dl", "dt", "dd", "body", "html",
]);

function textOf(node: HtmlNode): string {
  if (node.type === "text") return node.text;
  if (node.tag === "br") return "\n";
  return node.children.map(textOf).join("");
}

function styleFormat(style: string | undefined, base: RunFormat): RunFormat {
  const out = { ...base };
  if (!style) return out;
  const weight = /font-weight\s*:\s*([a-z0-9]+)/i.exec(style)?.[1]?.toLowerCase();
  if (weight === "bold" || weight === "bolder" || (weight && Number(weight) >= 600)) out.bold = true;
  if (weight === "normal" || (weight && Number(weight) > 0 && Number(weight) < 600)) delete out.bold;
  if (/font-style\s*:\s*italic/i.test(style)) out.italic = true;
  if (/text-decoration(?:-line)?\s*:[^;]*line-through/i.test(style)) out.strike = true;
  return out;
}

type Ctx = { depth: number; out: Block[] };

class InlineBuffer {
  runs: Run[] = [];
  push(text: string, format: RunFormat) {
    if (text) this.runs.push({ ...format, text });
  }
  take(): Run[] {
    const runs = this.runs;
    this.runs = [];
    return cleanRuns(runs);
  }
  get empty(): boolean {
    return plainText(this.runs).trim() === "";
  }
}

/** Collapse whitespace the way a browser renders it, and trim the ends. */
function cleanRuns(runs: Run[]): Run[] {
  const collapsed = runs.map((run) =>
    run.code ? run : { ...run, text: run.text.replace(/[ \t\r\f\v\u00a0]*\n[ \t\r\f\v\u00a0]*/g, "\n").replace(/[ \t\r\f\v]+/g, " ") },
  );
  const normalized = normalizeRuns(collapsed);
  // Trim leading and trailing whitespace across runs.
  while (normalized.length && !normalized[0].code && /^\s/.test(normalized[0].text)) {
    const text = normalized[0].text.replace(/^\s+/, "");
    if (text) normalized[0] = { ...normalized[0], text };
    else normalized.shift();
  }
  while (normalized.length) {
    const last = normalized[normalized.length - 1];
    if (last.code || !/\s$/.test(last.text)) break;
    const text = last.text.replace(/\s+$/, "");
    if (text) normalized[normalized.length - 1] = { ...last, text };
    else normalized.pop();
  }
  return linkifyRuns(normalized);
}

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (/^(?:javascript|vbscript|data):/i.test(trimmed)) return undefined;
  return trimmed;
}

function collectInline(node: HtmlNode, format: RunFormat, buffer: InlineBuffer, preserve: boolean) {
  if (node.type === "text") {
    buffer.push(preserve ? node.text : node.text.replace(/\s+/g, " "), format);
    return;
  }
  const tag = node.tag;
  if (SKIP_TAGS.has(tag)) return;
  if (tag === "br") {
    buffer.push("\n", format);
    return;
  }
  if (tag === "img") {
    const src = node.attrs.src;
    if (src && !/^data:/i.test(src)) {
      buffer.runs.push({ ...format, raw: true, text: `![${(node.attrs.alt ?? "").replace(/[[\]\\]/g, "")}](${src})` });
    }
    return;
  }
  if (tag === "input") return;
  let next: RunFormat = styleFormat(node.attrs.style, format);
  if (tag === "strong" || (tag === "b" && !/font-weight\s*:\s*normal/i.test(node.attrs.style ?? ""))) next.bold = true;
  if (tag === "em" || tag === "i" || tag === "cite") next.italic = true;
  if (tag === "s" || tag === "del" || tag === "strike") next.strike = true;
  if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") next = { ...next, code: true };
  if (tag === "a") {
    const href = safeHref(node.attrs.href);
    if (href) next = { ...next, href };
  }
  for (const child of node.children) collectInline(child, next, buffer, preserve || Boolean(next.code));
}

function isBlockElement(node: HtmlNode): boolean {
  if (node.type !== "element") return false;
  return (
    BLOCK_TAGS.has(node.tag) ||
    /^h[1-6]$/.test(node.tag) ||
    ["ul", "ol", "li", "blockquote", "pre", "hr", "table", "details", "summary"].includes(node.tag)
  );
}

function checkboxState(node: HtmlNode): boolean | null {
  if (node.type !== "element") return null;
  if (node.tag === "input" && (node.attrs.type ?? "").toLowerCase() === "checkbox") return "checked" in node.attrs;
  for (const child of node.children) {
    if (child.type === "text" && child.text.trim()) return null;
    const found = checkboxState(child);
    if (found !== null) return found;
    if (child.type === "element" && isBlockElement(child)) return null;
  }
  return null;
}

function tableText(table: HtmlNode): string {
  const rows: string[][] = [];
  const visit = (node: HtmlNode) => {
    if (node.type !== "element") return;
    if (node.tag === "tr") {
      const cells = node.children
        .filter((c): c is Extract<HtmlNode, { type: "element" }> => c.type === "element" && (c.tag === "td" || c.tag === "th"))
        .map((cell) => {
          const buffer = new InlineBuffer();
          for (const child of cell.children) collectInline(child, {}, buffer, false);
          return serializeInline(buffer.take()).replace(/\n/g, " ").replace(/\|/g, "\\|");
        });
      rows.push(cells);
      return;
    }
    node.children.forEach(visit);
  };
  visit(table);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...new Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [line(rows[0]), `| ${new Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function walkBlocks(nodes: readonly HtmlNode[], ctx: Ctx, format: RunFormat = {}) {
  const buffer = new InlineBuffer();
  const flush = () => {
    if (!buffer.empty) ctx.out.push(createBlock("paragraph", { depth: ctx.depth, runs: buffer.take() }));
    else buffer.take();
  };
  for (const node of nodes) {
    if (node.type === "text" || !isBlockElement(node)) {
      if (node.type === "element" && node.tag === "img" && buffer.empty) {
        const src = node.attrs.src;
        if (src && !/^data:/i.test(src)) {
          ctx.out.push(createBlock("image", { depth: ctx.depth, src, alt: node.attrs.alt ?? "" }));
        }
        continue;
      }
      collectInline(node, format, buffer, false);
      continue;
    }
    flush();
    blockElement(node, ctx, format);
  }
  flush();
}

function inlineRuns(node: Extract<HtmlNode, { type: "element" }>, format: RunFormat = {}): Run[] {
  const buffer = new InlineBuffer();
  for (const child of node.children) collectInline(child, format, buffer, false);
  return buffer.take();
}

function blockElement(node: Extract<HtmlNode, { type: "element" }>, ctx: Ctx, format: RunFormat) {
  const tag = node.tag;
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const runs = inlineRuns(node, format);
    if (plainText(runs).trim()) ctx.out.push(createBlock("heading", { depth: ctx.depth, level: Number(heading[1]), runs }));
    return;
  }
  if (tag === "hr") {
    ctx.out.push(createBlock("divider", { depth: ctx.depth }));
    return;
  }
  if (tag === "pre") {
    const code = node.children.find((c) => c.type === "element" && c.tag === "code") as
      | Extract<HtmlNode, { type: "element" }>
      | undefined;
    const cls = `${code?.attrs.class ?? ""} ${node.attrs.class ?? ""}`;
    const lang = /(?:language|lang)-([\w+#.-]+)/.exec(cls)?.[1] ?? "";
    const text = textOf(node).replace(/\r\n?/g, "\n").replace(/\n$/, "");
    ctx.out.push(createBlock("code", { depth: ctx.depth, text, lang }));
    return;
  }
  if (tag === "blockquote") {
    const inner: Block[] = [];
    walkBlocks(node.children, { depth: 0, out: inner }, format);
    const runs: Run[] = [];
    for (const b of inner) {
      const part = isRichText(b.type) ? b.runs : textRuns(b.text);
      if (plainText(part).trim() === "") continue;
      if (runs.length) runs.push({ text: "\n\n" });
      runs.push(...part);
    }
    if (runs.length) ctx.out.push(createBlock("quote", { depth: ctx.depth, runs: normalizeRuns(runs) }));
    return;
  }
  if (tag === "table") {
    const text = tableText(node);
    if (text) ctx.out.push(createBlock("table", { depth: ctx.depth, text }));
    return;
  }
  if (tag === "details") {
    const summary = node.children.find((c) => c.type === "element" && c.tag === "summary") as
      | Extract<HtmlNode, { type: "element" }>
      | undefined;
    ctx.out.push(createBlock("toggle", { depth: ctx.depth, runs: summary ? inlineRuns(summary, format) : [], open: true }));
    walkBlocks(node.children.filter((c) => c !== summary), { depth: ctx.depth + 1, out: ctx.out }, format);
    return;
  }
  if (tag === "ul" || tag === "ol") {
    let number = tag === "ol" ? Number(node.attrs.start ?? "1") || 1 : 0;
    let first = true;
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tag === "ul" || child.tag === "ol") {
        walkBlocks([child], { depth: ctx.depth + 1, out: ctx.out }, format);
        continue;
      }
      if (child.tag !== "li") continue;
      listItem(child, tag === "ol", first ? number : undefined, ctx, format);
      number++;
      first = false;
    }
    return;
  }
  if (tag === "li") {
    listItem(node, false, undefined, ctx, format);
    return;
  }
  walkBlocks(node.children, ctx, styleFormat(node.attrs.style, format));
}

function listItem(
  node: Extract<HtmlNode, { type: "element" }>,
  ordered: boolean,
  start: number | undefined,
  ctx: Ctx,
  format: RunFormat,
) {
  const role = node.attrs.role;
  let checked: boolean | null = checkboxState(node);
  if (checked === null && role === "checkbox") checked = node.attrs["aria-checked"] === "true";
  const buffer = new InlineBuffer();
  const rest: HtmlNode[] = [];
  let taking = true;
  for (const child of node.children) {
    if (taking && (child.type === "text" || !isBlockElement(child) || child.tag === "p" || child.tag === "div")) {
      if (child.type === "element" && (child.tag === "p" || child.tag === "div")) {
        if (!buffer.empty) {
          rest.push(child);
          taking = false;
          continue;
        }
        for (const inner of child.children) {
          if (inner.type === "element" && isBlockElement(inner)) rest.push(inner);
          else collectInline(inner, format, buffer, false);
        }
        continue;
      }
      collectInline(child, format, buffer, false);
      continue;
    }
    taking = false;
    rest.push(child);
  }
  const runs = buffer.take();
  const type = checked !== null ? "todo" : ordered ? "numbered" : "bulleted";
  ctx.out.push(
    createBlock(type, {
      depth: ctx.depth,
      runs,
      ...(type === "todo" ? { checked: Boolean(checked) } : {}),
      ...(type === "numbered" && start !== undefined ? { start } : {}),
    }),
  );
  if (rest.length) walkBlocks(rest, { depth: ctx.depth + 1, out: ctx.out }, format);
}

/** Convert pasted HTML into blocks. */
export function htmlToBlocks(root: HtmlNode): Block[] {
  const out: Block[] = [];
  const children = root.type === "element" ? root.children : [root];
  walkBlocks(children, { depth: 0, out });
  return normalizeDepths(out);
}

// ───────────────────────── Plain text and Markdown ──────────────────────────

const MARKDOWN_LINE = [
  /^#{1,6}\s+\S/,
  /^\s*[-*+]\s+\S/,
  /^\s*\d{1,9}[.)]\s+\S/,
  /^\s*[-*+]\s+\[[ xX]\]/,
  /^>\s?/,
  /^(?:```|~~~)/,
  /^\|?\s*:?-{3,}:?\s*\|/,
  /^(?:---|\*\*\*|___)\s*$/,
];

/** Does pasted text read as Markdown rather than plain lines? */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => MARKDOWN_LINE.some((re) => re.test(line)))) return true;
  return /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`/.test(text);
}

function freshCopy(blocks: readonly Block[]): Block[] {
  return blocks.map((b) => {
    const copy: Block = { ...b, id: newBlockId() };
    delete copy.origin;
    return copy;
  });
}

/** Blocks for pasted plain text: Markdown when it looks like Markdown, one block per line otherwise. */
export function textToBlocks(text: string): Block[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (looksLikeMarkdown(normalized)) return freshCopy(parseDoc(normalized).blocks);
  return normalized
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => createBlock("paragraph", { runs: linkifyRuns([{ text: line.trim() }]) }));
}

/** HTML worth converting has structure or formatting; otherwise its plain text says the same. */
export function htmlHasStructure(html: string): boolean {
  return /<(?:h[1-6]|ul|ol|li|table|blockquote|pre|strong|b|em|i|a|code|del|s|hr|img|details)\b/i.test(html);
}

export type ClipboardContent = {
  /** Markdown the editor itself put on the clipboard. */
  internal?: string;
  html?: string;
  text?: string;
};

/**
 * The blocks a paste should insert, from the richest clipboard flavour that
 * means something: the editor's own Markdown, then structured HTML, then
 * text. `parseHtml` is the browser's DOM-backed reader when available.
 */
export function blocksFromClipboard(
  content: ClipboardContent,
  parseHtml: (html: string) => HtmlNode = parseHtmlFragment,
): Block[] {
  if (content.internal) return freshCopy(parseDoc(content.internal).blocks);
  if (content.html && htmlHasStructure(content.html)) {
    const blocks = htmlToBlocks(parseHtml(content.html));
    if (blocks.length > 0) return blocks;
  }
  if (content.text) return textToBlocks(content.text);
  return [];
}
