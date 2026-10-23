/**
 * Inline rich text for the Notes editor.
 *
 * A block's text is a list of runs: stretches of characters sharing one
 * format (bold, italic, strikethrough, inline code, a link). The editor works
 * in runs because a caret position is a plain-text offset, and offsets into
 * runs line up with offsets into the contenteditable's text — offsets into
 * Markdown source would not.
 *
 * Notes are stored as Markdown, so runs come from Markdown and go back to it:
 * `parseInline` reads CommonMark/GFM inline syntax and `serializeInline`
 * writes it. Writing is checked by reading the result back: when Markdown
 * delimiters cannot express a stretch faithfully (`foo**(bar)**` does not
 * bold in CommonMark) the run is written with HTML tags instead, and the
 * reader understands those tags too. What the editor shows is what is saved.
 */

export type Run = {
  text: string;
  bold?: true;
  italic?: true;
  strike?: true;
  code?: true;
  href?: string;
  /** Link title from `[text](href "title")`, kept so an edit doesn't drop it. */
  title?: string;
  /** How a link was written when it wasn't `[text](href)`: `<https://…>` or a bare URL. */
  autolink?: "angle" | "bare";
  /**
   * Markdown the editor shows as written but doesn't model — inline HTML,
   * an inline image. Written back verbatim.
   */
  raw?: true;
};

export type MarkName = "bold" | "italic" | "strike" | "code";

/** The formatting part of a run: everything but its text. */
export type RunFormat = Omit<Run, "text">;

const FORMAT_KEYS = ["bold", "italic", "strike", "code", "href", "title", "autolink", "raw"] as const;

export function formatOf(run: Run): RunFormat {
  const out: RunFormat = {};
  if (run.bold) out.bold = true;
  if (run.italic) out.italic = true;
  if (run.strike) out.strike = true;
  if (run.code) out.code = true;
  if (run.href !== undefined) out.href = run.href;
  if (run.title !== undefined) out.title = run.title;
  if (run.autolink !== undefined) out.autolink = run.autolink;
  if (run.raw) out.raw = true;
  return out;
}

export function sameFormat(a: RunFormat, b: RunFormat): boolean {
  for (const key of FORMAT_KEYS) {
    if ((a[key] ?? undefined) !== (b[key] ?? undefined)) return false;
  }
  return true;
}

/** Drop empty runs and merge neighbours that share a format. */
export function normalizeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && sameFormat(last, run)) {
      out[out.length - 1] = { ...last, text: last.text + run.text };
    } else {
      out.push({ ...formatOf(run), text: run.text });
    }
  }
  return out;
}

export function plainText(runs: readonly Run[]): string {
  let text = "";
  for (const run of runs) text += run.text;
  return text;
}

export function runsLength(runs: readonly Run[]): number {
  let n = 0;
  for (const run of runs) n += run.text.length;
  return n;
}

export function textRuns(text: string): Run[] {
  return text ? [{ text }] : [];
}

export function runsEqual(a: readonly Run[], b: readonly Run[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || !sameFormat(a[i], b[i])) return false;
  }
  return true;
}

// ───────────────────────── Range operations ─────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** The runs covering `[start, end)`. */
export function sliceRuns(runs: readonly Run[], start: number, end: number): Run[] {
  const total = runsLength(runs);
  const from = clamp(start, 0, total);
  const to = clamp(end, from, total);
  const out: Run[] = [];
  let pos = 0;
  for (const run of runs) {
    const runStart = pos;
    const runEnd = pos + run.text.length;
    pos = runEnd;
    if (runEnd <= from || runStart >= to) continue;
    const a = Math.max(from, runStart) - runStart;
    const b = Math.min(to, runEnd) - runStart;
    out.push({ ...formatOf(run), text: run.text.slice(a, b) });
  }
  return normalizeRuns(out);
}

export function splitRuns(runs: readonly Run[], offset: number): [Run[], Run[]] {
  const total = runsLength(runs);
  return [sliceRuns(runs, 0, offset), sliceRuns(runs, offset, total)];
}

export function concatRuns(...parts: ReadonlyArray<readonly Run[]>): Run[] {
  return normalizeRuns(parts.flat());
}

/** Replace `[start, end)` with `insert`. */
export function replaceRange(
  runs: readonly Run[],
  start: number,
  end: number,
  insert: readonly Run[],
): Run[] {
  const total = runsLength(runs);
  return concatRuns(sliceRuns(runs, 0, start), insert, sliceRuns(runs, end, total));
}

export function deleteRange(runs: readonly Run[], start: number, end: number): Run[] {
  return replaceRange(runs, start, end, []);
}

/**
 * The format a character typed at `offset` takes: the character before it,
 * the way a word processor continues bold — except that typing never extends
 * a link or inline HTML, and at the very start it borrows from the character
 * after.
 */
export function formatAt(runs: readonly Run[], offset: number): RunFormat {
  let pos = 0;
  let before: Run | null = null;
  let after: Run | null = null;
  for (const run of runs) {
    const end = pos + run.text.length;
    if (offset > pos && offset <= end) before = run;
    if (offset >= pos && offset < end && !after) after = run;
    pos = end;
  }
  const source = before ?? after;
  if (!source) return {};
  const format = formatOf(source);
  delete format.href;
  delete format.title;
  delete format.autolink;
  delete format.raw;
  return format;
}

export function insertText(
  runs: readonly Run[],
  offset: number,
  text: string,
  format: RunFormat = formatAt(runs, offset),
): Run[] {
  return replaceRange(runs, offset, offset, [{ ...format, text }]);
}

function markOn(run: Run, mark: MarkName): boolean {
  return Boolean(run[mark]);
}

/** Does every character in `[start, end)` carry `mark`? False for an empty range. */
export function rangeHasMark(
  runs: readonly Run[],
  start: number,
  end: number,
  mark: MarkName,
): boolean {
  const slice = sliceRuns(runs, start, end);
  if (slice.length === 0) return false;
  return slice.every((run) => markOn(run, mark));
}

function withMark(run: Run, mark: MarkName, on: boolean): Run {
  const next: Run = { ...run };
  if (on) next[mark] = true;
  else delete next[mark];
  return next;
}

export function setMark(
  runs: readonly Run[],
  start: number,
  end: number,
  mark: MarkName,
  on: boolean,
): Run[] {
  if (end <= start) return normalizeRuns(runs);
  const middle = sliceRuns(runs, start, end).map((run) =>
    run.raw ? run : withMark(run, mark, on),
  );
  return replaceRange(runs, start, end, middle);
}

/** Bold/italic/… on when any of the range lacks it, off when all of it has it. */
export function toggleMark(
  runs: readonly Run[],
  start: number,
  end: number,
  mark: MarkName,
): Run[] {
  return setMark(runs, start, end, mark, !rangeHasMark(runs, start, end, mark));
}

/** Link `[start, end)` to `href`, or unlink it when `href` is null. */
export function setLink(
  runs: readonly Run[],
  start: number,
  end: number,
  href: string | null,
): Run[] {
  if (end <= start) return normalizeRuns(runs);
  const middle = sliceRuns(runs, start, end).map((run) => {
    const next: Run = { ...run };
    delete next.title;
    delete next.autolink;
    if (href) next.href = href;
    else delete next.href;
    return next;
  });
  return replaceRange(runs, start, end, middle);
}

/** The extent and target of the link touching `offset`, if any. */
export function linkAt(
  runs: readonly Run[],
  offset: number,
): { start: number; end: number; href: string } | null {
  let pos = 0;
  const spans: Array<{ start: number; end: number; href: string }> = [];
  for (const run of runs) {
    const end = pos + run.text.length;
    if (run.href !== undefined) {
      const last = spans[spans.length - 1];
      if (last && last.end === pos && last.href === run.href) last.end = end;
      else spans.push({ start: pos, end, href: run.href });
    }
    pos = end;
  }
  return spans.find((span) => offset >= span.start && offset <= span.end && span.end > span.start) ?? null;
}

/** Is this string a link someone would expect pasting over selected text to create? */
export function looksLikeUrl(text: string): boolean {
  return /^(?:https?:\/\/|mailto:)[^\s]+$/i.test(text.trim());
}

/**
 * A typed link target made into an address: a bare domain gets https://, an
 * email address mailto:. Null when it isn't one — and always for script and
 * data URLs, which have no business in a note.
 */
export function normalizeHref(input: string): string | null {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;
  if (/^(?:javascript|vbscript|data):/i.test(value)) return null;
  if (/^(?:https?:|mailto:|tel:|\/|#)/i.test(value)) return value;
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value)) return `mailto:${value}`;
  if (/^[\w-]+(\.[\w-]+)+(?::\d+)?(?:[/?#].*)?$/.test(value)) return `https://${value}`;
  return null;
}

/** Strip every mark and link: what code blocks and headings-turned-code keep. */
export function stripFormatting(runs: readonly Run[]): Run[] {
  return textRuns(plainText(runs));
}

// ───────────────────────── Character classes ────────────────────────────────

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && UNICODE_PUNCT.test(ch);
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** CommonMark's left/right-flanking test for a delimiter run between `before` and `after`. */
function flanking(before: string | undefined, after: string | undefined) {
  const left =
    !isWhitespace(after) &&
    (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  const right =
    !isWhitespace(before) &&
    (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
  return { left, right };
}

// ───────────────────────── Parsing ──────────────────────────────────────────

type DelimChar = "*" | "_" | "~";

type Delim = {
  kind: "delim";
  char: DelimChar;
  count: number;
  origCount: number;
  canOpen: boolean;
  canClose: boolean;
};

type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "raw"; text: string }
  | Delim
  | { kind: "tag"; mark: "bold" | "italic" | "strike"; closing: boolean; text: string }
  | {
      kind: "link";
      children: InlineNode[];
      href: string;
      title?: string;
      autolink?: "angle" | "bare";
    }
  | { kind: "wrap"; mark: "bold" | "italic" | "strike"; children: InlineNode[] };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  plusmn: "±",
  para: "¶",
  sect: "§",
  laquo: "«",
  raquo: "»",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  check: "✓",
};

const ENTITY = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/;

function matchEntity(src: string, i: number): { char: string; end: number } | null {
  const m = ENTITY.exec(src.slice(i, i + 40));
  if (!m) return null;
  let char: string | undefined;
  if (m[1] !== undefined || m[2] !== undefined) {
    const code = m[1] !== undefined ? Number(m[1]) : parseInt(m[2], 16);
    char = code === 0 || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
  } else {
    char = NAMED_ENTITIES[m[3]];
  }
  if (char === undefined) return null;
  return { char, end: i + m[0].length };
}

/** Would `&…` at `i` read as an entity? Used to decide when `&` needs escaping. */
function startsEntity(text: string, i: number): boolean {
  return matchEntity(text, i) !== null;
}

function countRun(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

/** Index of a backtick run of exactly `len` starting at or after `from`, or -1. */
function findBacktickClose(src: string, from: number, len: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "`") {
      const run = countRun(src, i, "`");
      if (run === len) return i;
      i += run;
    } else {
      i++;
    }
  }
  return -1;
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/&[^;\s]{1,32};/g, (entity) => {
    const m = matchEntity(entity, 0);
    return m ? m.char : entity;
  });
}

type LinkMatch = { end: number; label: string; href: string; title?: string };

/** Parse `[label](dest "title")` starting at the `[` at `i`. */
function parseLinkAt(src: string, i: number): LinkMatch | null {
  if (src[i] !== "[") return null;
  let depth = 1;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") {
      const run = countRun(src, j, "`");
      const close = findBacktickClose(src, j + run, run);
      j = close >= 0 ? close + run : j + run;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  if (j >= src.length || src[j + 1] !== "(") return null;
  const label = src.slice(i + 1, j);
  let k = j + 2;
  while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  let dest = "";
  if (src[k] === "<") {
    let close = k + 1;
    while (close < src.length && src[close] !== ">") {
      if (src[close] === "\\" && ASCII_PUNCT.test(src[close + 1] ?? "")) close++;
      else if (src[close] === "\n" || src[close] === "<") return null;
      close++;
    }
    if (close >= src.length) return null;
    dest = src.slice(k + 1, close);
    k = close + 1;
  } else {
    const start = k;
    let parens = 0;
    while (k < src.length) {
      const c = src[k];
      if (c === "\\" && ASCII_PUNCT.test(src[k + 1] ?? "")) {
        k += 2;
        continue;
      }
      if (c === "(") parens++;
      else if (c === ")") {
        if (parens === 0) break;
        parens--;
      } else if (c <= " " || /\s/.test(c)) break;
      k++;
    }
    if (parens !== 0) return null;
    dest = src.slice(start, k);
  }
  let title: string | undefined;
  const beforeTitle = k;
  while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  const opener = src[k];
  if (k > beforeTitle && (opener === '"' || opener === "'" || opener === "(")) {
    const closer = opener === "(" ? ")" : opener;
    let t = k + 1;
    while (t < src.length && src[t] !== closer) {
      if (src[t] === "\\") t++;
      t++;
    }
    if (t >= src.length) return null;
    title = unescapeMarkdown(src.slice(k + 1, t));
    k = t + 1;
    while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  }
  if (src[k] !== ")") return null;
  return { end: k + 1, label, href: unescapeMarkdown(dest), title };
}

const ANGLE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const ANGLE_EMAIL =
  /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const HTML_TAG =
  /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/;
const HTML_COMMENT = /^<!--[\s\S]*?-->/;

const TAG_MARKS: Record<string, "bold" | "italic" | "strike"> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  s: "strike",
  del: "strike",
  strike: "strike",
};

const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<]+/i;

/** GFM's autolink-literal extent: trailing punctuation and unbalanced `)` aren't part of the URL. */
function trimBareUrl(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last && /[?!.,:*_~'";]/.test(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (out.match(/\(/g) ?? []).length;
      const closes = (out.match(/\)/g) ?? []).length;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return out;
}

/** May a bare URL start right after this character? GFM: after whitespace, `(`, or an emphasis delimiter. */
function urlMayFollow(before: string | undefined): boolean {
  return before === undefined || /[\s(*_~]/.test(before);
}

/** The bare URL `text` starts with, if any (where it may start is the caller's business). */
function matchBareUrl(source: string): { text: string; href: string } | null {
  const m = BARE_URL.exec(source);
  if (!m) return null;
  const text = trimBareUrl(m[0]);
  if (/^www\.$/i.test(text) || /^https?:\/\/$/i.test(text)) return null;
  if (!/[A-Za-z0-9]/.test(text.replace(/^(?:https?:\/\/|www\.)/i, ""))) return null;
  const href = /^www\./i.test(text) ? `http://${text}` : text;
  return { text, href };
}

function tokenize(src: string, inLink = false): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      if (next !== undefined && ASCII_PUNCT.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
      if (next === "\n") {
        buf += "\n";
        i += 2;
        while (src[i] === " " || src[i] === "\t") i++;
        continue;
      }
      buf += "\\";
      i++;
      continue;
    }
    if (ch === "`") {
      const run = countRun(src, i, "`");
      const close = findBacktickClose(src, i + run, run);
      if (close >= 0) {
        flush();
        let code = src.slice(i + run, close).replace(/\n/g, " ");
        if (code.length >= 2 && code[0] === " " && code[code.length - 1] === " " && code.trim()) {
          code = code.slice(1, -1);
        }
        out.push({ kind: "code", text: code });
        i = close + run;
        continue;
      }
      buf += "`".repeat(run);
      i += run;
      continue;
    }
    if (ch === "!" && src[i + 1] === "[") {
      const image = parseLinkAt(src, i + 1);
      if (image) {
        flush();
        out.push({ kind: "raw", text: src.slice(i, image.end) });
        i = image.end;
        continue;
      }
      buf += "!";
      i++;
      continue;
    }
    if (ch === "[" && !inLink) {
      const link = parseLinkAt(src, i);
      if (link) {
        flush();
        out.push({
          kind: "link",
          children: resolveTags(tokenize(link.label, true)),
          href: link.href,
          ...(link.title !== undefined ? { title: link.title } : {}),
        });
        i = link.end;
        continue;
      }
    }
    if (ch === "<") {
      const rest = src.slice(i, i + 2000);
      const scheme = inLink ? null : ANGLE_AUTOLINK.exec(rest);
      const email = inLink || scheme ? null : ANGLE_EMAIL.exec(rest);
      const auto = scheme ?? email;
      if (auto) {
        flush();
        out.push({
          kind: "link",
          children: [{ kind: "text", text: auto[1] }],
          href: scheme ? auto[1] : `mailto:${auto[1]}`,
          autolink: "angle",
        });
        i += auto[0].length;
        continue;
      }
      const comment = HTML_COMMENT.exec(rest);
      const tag = comment ?? HTML_TAG.exec(rest);
      if (tag) {
        flush();
        const text = tag[0];
        const simple = /^<(\/?)([A-Za-z]+)>$/.exec(text);
        const mark = simple ? TAG_MARKS[simple[2].toLowerCase()] : undefined;
        if (simple && mark) out.push({ kind: "tag", mark, closing: simple[1] === "/", text });
        else out.push({ kind: "raw", text });
        i += text.length;
        continue;
      }
      buf += "<";
      i++;
      continue;
    }
    if (ch === "&") {
      const entity = matchEntity(src, i);
      if (entity) {
        buf += entity.char;
        i = entity.end;
        continue;
      }
      buf += "&";
      i++;
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const run = countRun(src, i, ch);
      const before = i === 0 ? undefined : src[i - 1];
      const after = src[i + run];
      const { left, right } = flanking(before, after);
      let canOpen = left;
      let canClose = right;
      if (ch === "_") {
        canOpen = left && (!right || isPunctuation(before));
        canClose = right && (!left || isPunctuation(after));
      }
      if (ch === "~" && run > 2) {
        canOpen = false;
        canClose = false;
      }
      flush();
      out.push({ kind: "delim", char: ch, count: run, origCount: run, canOpen, canClose });
      i += run;
      continue;
    }
    if (ch === "\n") {
      buf = buf.replace(/[ \t]+$/, "");
      // A hard break can arrive as a trailing backslash already folded into
      // `buf`; either way the line ends here.
      buf += "\n";
      i++;
      while (src[i] === " " || src[i] === "\t") i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Pair simple HTML formatting tags (`<b>…</b>`) into wraps; strays stay literal. */
function resolveTags(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  const stack: Array<{ mark: "bold" | "italic" | "strike"; index: number }> = [];
  for (const node of nodes) {
    if (node.kind !== "tag") {
      out.push(node);
      continue;
    }
    if (!node.closing) {
      stack.push({ mark: node.mark, index: out.length });
      out.push(node);
      continue;
    }
    let match = -1;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s].mark === node.mark) {
        match = s;
        break;
      }
    }
    if (match < 0) {
      out.push({ kind: "raw", text: node.text });
      continue;
    }
    const opener = stack[match];
    stack.length = match;
    const children = out.splice(opener.index);
    children.shift();
    out.push({ kind: "wrap", mark: node.mark, children: resolveTags(children) });
  }
  return out.map((node) =>
    node.kind === "tag" ? { kind: "raw", text: node.text } : node,
  );
}

/** CommonMark's "process emphasis", over one level of nodes. */
function processEmphasis(input: InlineNode[]): InlineNode[] {
  const nodes = input.map((node): InlineNode => {
    if (node.kind === "link") return { ...node, children: processEmphasis(node.children) };
    if (node.kind === "wrap") return { ...node, children: processEmphasis(node.children) };
    return node;
  });
  let pos = 0;
  while (pos < nodes.length) {
    const closer = nodes[pos];
    if (closer.kind !== "delim" || !closer.canClose || closer.count === 0) {
      pos++;
      continue;
    }
    let found = -1;
    for (let o = pos - 1; o >= 0; o--) {
      const opener = nodes[o];
      if (opener.kind !== "delim" || opener.char !== closer.char) continue;
      if (!opener.canOpen || opener.count === 0) continue;
      if (closer.char === "~") {
        if (opener.count !== closer.count) continue;
      } else if (
        (opener.canClose || closer.canOpen) &&
        (opener.origCount + closer.origCount) % 3 === 0 &&
        !(opener.origCount % 3 === 0 && closer.origCount % 3 === 0)
      ) {
        continue;
      }
      found = o;
      break;
    }
    if (found < 0) {
      pos++;
      continue;
    }
    const opener = nodes[found] as Delim;
    let use: number;
    let mark: "bold" | "italic" | "strike";
    if (closer.char === "~") {
      use = closer.count;
      mark = "strike";
    } else {
      use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      mark = use === 2 ? "bold" : "italic";
    }
    const inner = nodes.slice(found + 1, pos);
    const nextOpener: Delim = { ...opener, count: opener.count - use };
    const nextCloser: Delim = { ...closer, count: closer.count - use };
    const replacement: InlineNode[] = [];
    if (nextOpener.count > 0) replacement.push(nextOpener);
    replacement.push({ kind: "wrap", mark, children: inner });
    if (nextCloser.count > 0) replacement.push(nextCloser);
    nodes.splice(found, pos - found + 1, ...replacement);
    pos = found + replacement.length - (nextCloser.count > 0 ? 1 : 0);
  }
  return nodes;
}

function flatten(nodes: InlineNode[], format: RunFormat, out: Run[]) {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out.push({ ...format, text: node.text });
        break;
      case "code":
        out.push({ ...format, code: true, text: node.text });
        break;
      case "raw":
        out.push({ ...format, raw: true, text: node.text });
        break;
      case "delim":
        out.push({ ...format, text: node.char.repeat(node.count) });
        break;
      case "tag":
        out.push({ ...format, raw: true, text: node.text });
        break;
      case "wrap":
        flatten(node.children, { ...format, [node.mark]: true }, out);
        break;
      case "link": {
        const linkFormat: RunFormat = { ...format, href: node.href };
        if (node.title !== undefined) linkFormat.title = node.title;
        if (node.autolink) linkFormat.autolink = node.autolink;
        flatten(node.children, linkFormat, out);
        break;
      }
    }
  }
}

/** Read CommonMark/GFM inline Markdown into runs. */
export function parseInline(src: string): Run[] {
  if (!src) return [];
  const nodes = processEmphasis(resolveTags(tokenize(src)));
  const out: Run[] = [];
  flatten(nodes, {}, out);
  return linkifyRuns(out);
}

// ───────────────────────── Serializing ──────────────────────────────────────

type Char = { ch: string; format: RunFormat };

function explode(runs: readonly Run[]): Char[] {
  const out: Char[] = [];
  for (const run of runs) {
    const format = formatOf(run);
    if (run.raw) {
      // Raw Markdown is one indivisible unit: never split or re-marked.
      out.push({ ch: run.text, format });
      continue;
    }
    for (const ch of Array.from(run.text)) out.push({ ch, format });
  }
  return out;
}

function implode(chars: Char[]): Run[] {
  return normalizeRuns(chars.map((c) => ({ ...c.format, text: c.ch })));
}

function withoutKey(format: RunFormat, key: keyof RunFormat): RunFormat {
  const next = { ...format };
  delete next[key];
  return next;
}

/**
 * GFM turns a bare `https://…` or `www.…` into a link when Markdown is read,
 * after emphasis is resolved and within one stretch of same-formatted text.
 * The reader does exactly that, so plain text holding a URL is a link once
 * saved; the editor calls it too, so a typed URL is clickable at once.
 */
export function linkifyRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  let before: string | undefined;
  for (const run of normalizeRuns(runs)) {
    if (run.href !== undefined || run.code || run.raw) {
      out.push(run);
      before = run.text[run.text.length - 1];
      continue;
    }
    const format = formatOf(run);
    const text = run.text;
    let buf = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      const prev = i === 0 ? before : text[i - 1];
      if (/[hHwW]/.test(ch) && urlMayFollow(prev)) {
        const url = matchBareUrl(text.slice(i));
        if (url) {
          if (buf) out.push({ ...format, text: buf });
          buf = "";
          out.push({ ...format, text: url.text, href: url.href, autolink: "bare" });
          i += url.text.length;
          continue;
        }
      }
      buf += ch;
      i++;
    }
    if (buf) out.push({ ...format, text: buf });
    before = text[text.length - 1];
  }
  return normalizeRuns(out);
}

/**
 * The runs as they can be written: newlines inside inline code become spaces
 * (a code span can't hold one), whitespace beside a line break is dropped
 * (Markdown strips it), bold/italic/strike never start or end on whitespace
 * (`** bold**` is not bold), and bare URLs are links. Also what a round trip
 * is compared against.
 */
export function canonicalRuns(runs: readonly Run[]): Run[] {
  const chars = explode(
    runs.map((run) =>
      run.code && !run.raw ? { ...run, text: run.text.replace(/\n/g, " ") } : run,
    ),
  );
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].ch !== "\n" || chars[i].format.code || chars[i].format.raw) continue;
    for (let a = i - 1; a >= 0 && /^[ \t]$/.test(chars[a].ch) && !chars[a].format.code; a--) {
      chars[a] = { ...chars[a], ch: "" };
    }
    for (
      let b = i + 1;
      b < chars.length && /^[ \t]$/.test(chars[b].ch) && !chars[b].format.code;
      b++
    ) {
      chars[b] = { ...chars[b], ch: "" };
    }
  }
  const live = chars.filter((c) => c.ch !== "");
  for (const mark of ["bold", "italic", "strike"] as const) {
    let i = 0;
    while (i < live.length) {
      if (!live[i].format[mark]) {
        i++;
        continue;
      }
      let j = i;
      while (j < live.length && live[j].format[mark]) j++;
      let a = i;
      while (a < j && /^\s$/.test(live[a].ch) && !live[a].format.code) {
        live[a] = { ch: live[a].ch, format: withoutKey(live[a].format, mark) };
        a++;
      }
      for (let b = j - 1; b >= a && /^\s$/.test(live[b].ch) && !live[b].format.code; b--) {
        live[b] = { ch: live[b].ch, format: withoutKey(live[b].format, mark) };
      }
      i = j;
    }
  }
  // A link with nothing but whitespace to click is just whitespace.
  const runsOut = implode(live);
  const linkText = new Map<string, string>();
  for (const run of runsOut) {
    if (run.href !== undefined) linkText.set(run.href, (linkText.get(run.href) ?? "") + run.text);
  }
  const unlinked = runsOut.map((run) => {
    if (run.href === undefined || /\S/.test(linkText.get(run.href) ?? "")) return run;
    const next = { ...run };
    delete next.href;
    delete next.title;
    delete next.autolink;
    return next;
  });
  return linkifyRuns(unlinked);
}

function codeSpan(text: string): string {
  let longest = 0;
  for (const m of text.match(/`+/g) ?? []) longest = Math.max(longest, m.length);
  const fence = "`".repeat(longest + 1);
  const pad =
    text.startsWith("`") ||
    text.endsWith("`") ||
    (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "");
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Escape what Markdown would otherwise read as syntax. `before`/`after` are
 * the characters written just outside this text (a delimiter, a bracket, or
 * undefined at the very edge), so the characters at its edges are judged
 * against what will actually sit beside them.
 */
function escapeText(text: string, before?: string, after?: string): string {
  const chars = Array.from(text);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const prev = i === 0 ? before : chars[i - 1];
    const next = i === chars.length - 1 ? after : chars[i + 1];
    switch (c) {
      case "\\":
        out += next === undefined || ASCII_PUNCT.test(next) || next === "\n" ? "\\\\" : "\\";
        break;
      case "*":
      case "~":
        out += isSpace(prev) && isSpace(next) ? c : `\\${c}`;
        break;
      case "_":
        out += (isAlnum(prev) && isAlnum(next)) || (isSpace(prev) && isSpace(next)) ? c : "\\_";
        break;
      case "`":
      case "[":
      case "]":
        out += `\\${c}`;
        break;
      case "!":
        out += next === "[" ? "\\!" : "!";
        break;
      case "<":
        out += next !== undefined && /[A-Za-z/!?]/.test(next) ? "\\<" : "<";
        break;
      case "&":
        out += startsEntity(chars.slice(i).join(""), 0) ? "\\&" : "&";
        break;
      default:
        out += c;
    }
  }
  return out;
}

type Style = "markdown" | "html";

const MARK_ORDER = ["strike", "bold", "italic"] as const;
type DelimMark = (typeof MARK_ORDER)[number];

function openDelim(mark: DelimMark, style: Style): string {
  if (style === "html") return mark === "bold" ? "<strong>" : mark === "italic" ? "<em>" : "<del>";
  return mark === "bold" ? "**" : mark === "italic" ? "*" : "~~";
}

function closeDelim(mark: DelimMark, style: Style): string {
  if (style === "html") {
    return mark === "bold" ? "</strong>" : mark === "italic" ? "</em>" : "</del>";
  }
  return openDelim(mark, style);
}

/** The first character a run writes, ignoring delimiters opened before it. */
function leadingChar(run: Run): string | undefined {
  if (run.code && !run.raw) return "`";
  return run.text[0];
}

function marksOf(run: Run): DelimMark[] {
  return MARK_ORDER.filter((m) => run[m]);
}

/** Write one stretch of runs outside any link. `before`/`after` are its outside neighbours. */
function emitSegment(runs: Run[], style: Style, before?: string, after?: string): string {
  let out = "";
  const stack: DelimMark[] = [];
  const delimChar = style === "html" ? "<" : "*";
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const target = new Set<DelimMark>(marksOf(run));
    let keep = 0;
    while (keep < stack.length && target.has(stack[keep])) keep++;
    while (stack.length > keep) out += closeDelim(stack.pop()!, style);
    for (const mark of MARK_ORDER) {
      if (target.has(mark) && !stack.includes(mark)) {
        stack.push(mark);
        out += openDelim(mark, style);
      }
    }
    if (run.raw) {
      out += run.text;
      continue;
    }
    if (run.code) {
      out += codeSpan(run.text);
      continue;
    }
    const next = runs[r + 1];
    let nextChar: string | undefined;
    if (next) {
      const nextMarks = marksOf(next);
      const same = nextMarks.length === target.size && nextMarks.every((m) => target.has(m));
      nextChar = same ? leadingChar(next) : delimChar;
    } else {
      nextChar = stack.length > 0 ? delimChar : after;
    }
    const prevChar = out.length > 0 ? out[out.length - 1] : before;
    out += escapeText(run.text, prevChar, nextChar);
  }
  while (stack.length) out += closeDelim(stack.pop()!, style);
  return out;
}

function escapeHref(href: string): string {
  if (href === "" || /[\s<>]/.test(href)) {
    return `<${href.replace(/[<>\\]/g, (c) => `\\${c}`)}>`;
  }
  let depth = 0;
  let balanced = true;
  for (const c of href) {
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) balanced = false;
    }
  }
  if (depth !== 0) balanced = false;
  let escaped = href.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\");
  escaped = escaped.replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&");
  return balanced ? escaped : escaped.replace(/[()]/g, (c) => `\\${c}`);
}

function escapeTitle(title: string): string {
  return `"${title.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

function stripLink(run: Run): Run {
  const next: Run = { ...run };
  delete next.href;
  delete next.title;
  delete next.autolink;
  return next;
}

function isPlainRun(run: Run): boolean {
  return !run.bold && !run.italic && !run.strike && !run.code && !run.raw;
}

/** What the first written character of a link group will be. */
function linkLeadingChar(run: Run): string {
  if (run.autolink === "bare") return run.text[0] ?? "[";
  if (run.autolink === "angle") return "<";
  return "[";
}

/** Does `text` alone read back as exactly one bare link to `href`? */
function readsAsBareLink(text: string, href: string): boolean {
  const alone = parseInline(text);
  return alone.length === 1 && alone[0].text === text && alone[0].href === href;
}

function emit(runs: Run[], style: Style, explicitLinks = false): string {
  let out = "";
  let i = 0;
  while (i < runs.length) {
    const run = runs[i];
    let j = i + 1;
    if (run.href === undefined) {
      while (j < runs.length && runs[j].href === undefined) j++;
    } else {
      while (
        j < runs.length &&
        runs[j].href === run.href &&
        runs[j].title === run.title &&
        runs[j].autolink === run.autolink
      ) {
        j++;
      }
    }
    const group = runs.slice(i, j);
    const following = runs[j];
    const prevChar = out.length > 0 ? out[out.length - 1] : undefined;
    if (run.href === undefined) {
      let nextChar: string | undefined;
      if (following) {
        nextChar = following.href === undefined ? leadingChar(following) : linkLeadingChar(following);
      }
      out += emitSegment(group, style, prevChar, nextChar);
      i = j;
      continue;
    }
    const text = plainText(group);
    const plain = group.every(isPlainRun);
    const bare = matchBareUrl(text);
    const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(text);
    // Read back, a bare URL is found within its own stretch of text, so it
    // must start where a URL may start and must not run on into plain text
    // that follows it.
    const before = i > 0 ? runs[i - 1].text[runs[i - 1].text.length - 1] : undefined;
    const runsOn =
      following !== undefined &&
      following.href === undefined &&
      isPlainRun(following) &&
      matchBareUrl(text + following.text)?.text !== text;
    if (
      !explicitLinks &&
      run.autolink === "bare" &&
      plain &&
      !runsOn &&
      bare?.text === text &&
      bare.href === run.href &&
      urlMayFollow(before) &&
      (prevChar === undefined || urlMayFollow(prevChar) || prevChar === "*" || prevChar === ">") &&
      readsAsBareLink(text, run.href)
    ) {
      out += text;
    } else if (
      !explicitLinks &&
      run.autolink !== undefined &&
      run.title === undefined &&
      plain &&
      !/[\s<>]/.test(text) &&
      (hasScheme ? text === run.href : `mailto:${text}` === run.href)
    ) {
      out += `<${text}>`;
    } else {
      const label = emitSegment(group.map(stripLink), style, "[", "]");
      const title = run.title !== undefined ? ` ${escapeTitle(run.title)}` : "";
      out += `[${label}](${escapeHref(run.href)}${title})`;
    }
    i = j;
  }
  return out;
}

/**
 * Write runs as inline Markdown: delimiters (`**`, `*`, `~~`) when they read
 * back as written, HTML tags for the rare stretch delimiters can't express
 * (`foo**(bar)**` is not bold in CommonMark). Either way the result is read
 * back and compared, so what the editor showed is what is saved.
 */
export function serializeInline(runs: readonly Run[]): string {
  const canonical = canonicalRuns(runs);
  if (canonical.length === 0) return "";
  let first: string | null = null;
  const attempts: Array<[Style, boolean]> = [
    ["markdown", false],
    ["html", false],
    ["html", true],
  ];
  for (const [style, explicitLinks] of attempts) {
    const md = emit(canonical, style, explicitLinks);
    first ??= md;
    if (sameInlineContent(parseInline(md), canonical)) return md;
  }
  return first ?? "";
}

/**
 * Do two run lists say the same thing once written? Compares canonical
 * forms, and treats `<https://x>` and a bare `https://x` as the same link.
 */
export function sameInlineContent(a: readonly Run[], b: readonly Run[]): boolean {
  const strip = (runs: readonly Run[]) =>
    normalizeRuns(
      canonicalRuns(runs).map((run) => {
        const next: Run = { ...run };
        delete next.autolink;
        return next;
      }),
    );
  return runsEqual(strip(a), strip(b));
}
