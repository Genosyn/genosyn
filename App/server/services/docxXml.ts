/**
 * A tiny XML reader for OOXML that remembers where everything was.
 *
 * ## Why not an XML library
 *
 * Editing a Word document is not a transformation of a document tree — it is a
 * repair to one region of a file whose every other byte must survive
 * untouched. `word/document.xml` carries revision ids, `w:rsid*` attributes,
 * proofing state, theme references and vendor extension namespaces that no
 * generic parser round-trips faithfully: attribute order changes, self-closing
 * tags gain a space, `xml:space="preserve"` gets normalized away, and the file
 * Word opens afterwards is subtly not the file the human sent. That damage is
 * invisible in a diff and obvious in Word.
 *
 * So this parser produces a read-only view — every node records the exact
 * offsets it occupies in the source string — and every edit is expressed as a
 * splice against that string ({@link applyEdits}). Regions nobody touched come
 * out byte-identical, because they are literally the same bytes.
 *
 * ## What it deliberately does not do
 *
 * No DTDs, no entity declarations, no namespace resolution (OOXML prefixes are
 * fixed by convention and we match on the qualified name). It is not a
 * general-purpose parser and must not be sold as one; it is exactly enough to
 * read and repair the machine-generated XML inside an Office package.
 */

/** Anything the caller passed that is not well-formed enough to work on. */
export class XmlParseError extends Error {
  readonly status = 400;
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = "XmlParseError";
    this.offset = offset;
  }
}

export type XmlNode = {
  /** Qualified name as written, e.g. `w:p`. */
  name: string;
  /** Name with any namespace prefix removed, e.g. `p`. */
  local: string;
  /** Attributes by qualified name, values already entity-decoded. */
  attrs: Record<string, string>;
  children: XmlNode[];
  parent: XmlNode | null;
  /** Offset of the `<` that opens this element. */
  start: number;
  /** Offset one past the `>` that closes it. */
  end: number;
  /** Offset one past the `>` of the opening tag. */
  innerStart: number;
  /** Offset of the `<` of the closing tag. Equals `innerStart` when empty. */
  innerEnd: number;
  selfClosing: boolean;
};

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Parse a whole XML document and return its root element.
 *
 * Prologue, comments, doctype and processing instructions are skipped rather
 * than modelled — nothing we edit lives in them, and keeping them out of the
 * tree means a caller iterating `children` never has to filter.
 */
export function parseXml(source: string): XmlNode {
  let i = 0;
  const length = source.length;
  let root: XmlNode | null = null;
  let current: XmlNode | null = null;

  // Annotated rather than inferred: TypeScript only treats a call as
  // never-returning when the identifier carries an explicit type, and without
  // that every `fail(...)` below would leave `current` looking nullable.
  const fail: (message: string, at: number) => never = (message, at) => {
    throw new XmlParseError(message, at);
  };

  while (i < length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;
    i = lt;

    if (source.startsWith("<!--", i)) {
      const close = source.indexOf("-->", i + 4);
      if (close === -1) fail("Unterminated comment", i);
      i = close + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const close = source.indexOf("]]>", i + 9);
      if (close === -1) fail("Unterminated CDATA section", i);
      i = close + 3;
      continue;
    }
    if (source.startsWith("<?", i)) {
      const close = source.indexOf("?>", i + 2);
      if (close === -1) fail("Unterminated processing instruction", i);
      i = close + 2;
      continue;
    }
    if (source.startsWith("<!", i)) {
      // A DOCTYPE. Office never writes one; skip to the matching `>` while
      // stepping over any internal subset so a nested `>` cannot end it early.
      let depth = 0;
      let j = i + 2;
      for (; j < length; j += 1) {
        const ch = source[j];
        if (ch === "[") depth += 1;
        else if (ch === "]") depth -= 1;
        else if (ch === ">" && depth <= 0) break;
      }
      if (j >= length) fail("Unterminated declaration", i);
      i = j + 1;
      continue;
    }

    if (source[i + 1] === "/") {
      // Closing tag.
      let j = i + 2;
      while (j < length && NAME_CHAR.test(source[j])) j += 1;
      const name = source.slice(i + 2, j);
      while (j < length && isSpace(source[j])) j += 1;
      if (source[j] !== ">") fail(`Malformed closing tag for <${name}>`, i);
      if (!current) fail(`Closing tag </${name}> with nothing open`, i);
      if (current.name !== name) {
        fail(`Closing tag </${name}> does not match open <${current.name}>`, i);
      }
      current.innerEnd = i;
      current.end = j + 1;
      current = current.parent;
      i = j + 1;
      continue;
    }

    // Opening tag.
    if (!NAME_START.test(source[i + 1] ?? "")) fail("Malformed tag", i);
    let j = i + 1;
    while (j < length && NAME_CHAR.test(source[j])) j += 1;
    const name = source.slice(i + 1, j);
    const attrs: Record<string, string> = {};

    for (;;) {
      while (j < length && isSpace(source[j])) j += 1;
      if (j >= length) fail(`Unterminated tag <${name}>`, i);
      const ch = source[j];
      if (ch === ">" || (ch === "/" && source[j + 1] === ">")) break;
      if (!NAME_START.test(ch)) fail(`Malformed attribute in <${name}>`, j);
      const attrStart = j;
      while (j < length && NAME_CHAR.test(source[j])) j += 1;
      const attrName = source.slice(attrStart, j);
      while (j < length && isSpace(source[j])) j += 1;
      if (source[j] !== "=") fail(`Attribute ${attrName} has no value`, j);
      j += 1;
      while (j < length && isSpace(source[j])) j += 1;
      const quote = source[j];
      if (quote !== '"' && quote !== "'") fail(`Attribute ${attrName} is not quoted`, j);
      const valueStart = j + 1;
      const valueEnd = source.indexOf(quote, valueStart);
      if (valueEnd === -1) fail(`Unterminated value for ${attrName}`, j);
      attrs[attrName] = decodeXmlText(source.slice(valueStart, valueEnd));
      j = valueEnd + 1;
    }

    const selfClosing = source[j] === "/";
    const tagEnd = selfClosing ? j + 2 : j + 1;
    const node: XmlNode = {
      name,
      local: name.includes(":") ? name.slice(name.indexOf(":") + 1) : name,
      attrs,
      children: [],
      parent: current,
      start: i,
      end: selfClosing ? tagEnd : -1,
      innerStart: tagEnd,
      innerEnd: selfClosing ? tagEnd : -1,
      selfClosing,
    };
    if (current) current.children.push(node);
    else if (root) fail("Document has more than one root element", i);
    else root = node;
    if (!selfClosing) current = node;
    i = tagEnd;
  }

  if (current) throw new XmlParseError(`Unclosed element <${current.name}>`, current.start);
  if (!root) throw new XmlParseError("Document has no root element", 0);
  return root;
}

/** Direct children with the given qualified name. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** The first direct child with the given qualified name, if any. */
export function firstChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

/**
 * Every descendant with the given qualified name, in document order.
 *
 * `stopAt` prunes whole subtrees before descending — the way to read a
 * paragraph's own runs without collecting the runs of a table nested inside it.
 */
export function descendantsNamed(
  node: XmlNode,
  name: string,
  stopAt: ReadonlySet<string> = new Set(),
): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const child of n.children) {
      if (child.name === name) out.push(child);
      if (stopAt.has(child.name)) continue;
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** Depth-first walk in document order, including `node` itself. */
export function walkXml(node: XmlNode, visit: (n: XmlNode) => void): void {
  visit(node);
  for (const child of node.children) walkXml(child, visit);
}

/** The source text of an element including its own tags. */
export function outerXml(source: string, node: XmlNode): string {
  return source.slice(node.start, node.end);
}

/** The source text between an element's tags, tags and all. */
export function innerXml(source: string, node: XmlNode): string {
  return node.selfClosing ? "" : source.slice(node.innerStart, node.innerEnd);
}

/**
 * Concatenated character data of an element and its descendants, decoded.
 *
 * `skip` prunes subtrees whose text is markup rather than content —
 * `w:rPr` (formatting), `w:instrText` (a field's instruction) and `w:delText`
 * (text a tracked deletion already removed) all read as gibberish if included.
 */
export function textContent(
  source: string,
  node: XmlNode,
  skip: ReadonlySet<string> = new Set(),
): string {
  if (node.selfClosing) return "";
  let out = "";
  let cursor = node.innerStart;
  for (const child of node.children) {
    out += decodeXmlText(source.slice(cursor, child.start));
    if (!skip.has(child.name)) out += textContent(source, child, skip);
    cursor = child.end;
  }
  out += decodeXmlText(source.slice(cursor, node.innerEnd));
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Turn XML character references back into the characters they stand for. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code, whole) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code, whole) : whole;
    }
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * Characters XML 1.0 cannot carry at all — not even as a numeric reference.
 *
 * Word refuses to open a document containing one, and they arrive more often
 * than you would think: a model that read a PDF and is writing the answer back
 * out can carry a stray form feed or a NUL through with it. Dropping them is
 * the only repair available, so it happens once, here, rather than in each
 * caller. Unpaired surrogates go the same way — they survive inside a
 * JavaScript string but cannot be encoded as UTF-8 on the way into the zip.
 *
 * Written with escapes rather than literal bytes so the source file stays
 * plain text; a control character embedded here makes the whole module read
 * as binary to `grep` and to a code review.
 */
const XML_ILLEGAL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Strip the characters XML cannot represent. */
export function stripXmlIllegalChars(value: string): string {
  return value.replace(XML_ILLEGAL, "");
}

/** Escape a string for use as element character data. */
export function escapeXmlText(value: string): string {
  return stripXmlIllegalChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a string for use inside a double-quoted attribute value. */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

/** One replacement of `[start, end)` in the source string. */
export type XmlEdit = {
  start: number;
  end: number;
  replacement: string;
};

/**
 * Apply splices to the source, right to left, so earlier offsets stay valid.
 *
 * Overlapping edits are a bug in the caller — two operations both claiming the
 * same run — and the result of applying them would depend on order, so they are
 * refused rather than silently resolved. Insertions (zero-length ranges) at the
 * same offset are kept in the order given, which is what "insert these two
 * paragraphs after that one" has to mean.
 */
export function applyEdits(source: string, edits: readonly XmlEdit[]): string {
  if (edits.length === 0) return source;
  const ordered = edits.map((edit, index) => ({ ...edit, index }));
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) {
      throw new XmlParseError(
        `Edit range ${edit.start}..${edit.end} is outside the document`,
        edit.start,
      );
    }
  }
  ordered.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const next = ordered[i];
    if (next.start < previous.end) {
      throw new XmlParseError(
        `Two edits overlap at offset ${next.start}; each region may be changed once`,
        next.start,
      );
    }
  }
  const pieces: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    pieces.push(source.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  pieces.push(source.slice(cursor));
  return pieces.join("");
}
