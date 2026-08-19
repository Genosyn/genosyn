/**
 * A tiny, dependency-free syntax tokenizer for the repository editor.
 *
 * The one invariant everything else rests on: concatenating every token's text
 * reproduces the input byte for byte. The tokens are painted in a `<pre>` layered
 * under a transparent textarea, so a single dropped or duplicated character would
 * shift the whole overlay out of alignment with the text people are actually
 * editing. Every rule therefore takes its text straight out of `source` with a
 * slice, and any gap between matches is emitted as a plain token rather than
 * skipped.
 *
 * The grammars are deliberately shallow. They are decoration for someone reading
 * a file, not a parser — a regex literal containing a quote or a shell `#` inside
 * a parameter expansion will be coloured wrong, and that is an acceptable trade
 * for never crashing and never mangling.
 */

export type TokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "tag"
  | "attr"
  | "punctuation";

export type Token = {
  text: string;
  kind: TokenKind;
};

type Rule = {
  /** Sticky pattern, tried at exactly the current offset. */
  re: RegExp;
  kind: TokenKind;
  /** Only tried at the first character of a line. */
  atLineStart?: boolean;
  /** Extra guard for rules that would otherwise fire mid-word. */
  where?: (source: string, index: number) => boolean;
  /** Refines the kind once the matched text is known — keyword lists, mostly. */
  classify?: (text: string) => TokenKind;
};

/** True at the start of input or immediately after any whitespace. */
function afterWhitespace(source: string, index: number): boolean {
  return index === 0 || /\s/.test(source[index - 1]);
}

/**
 * True unless the previous character could be part of the same word. Grammars
 * with no identifier rule of their own need this so `null` inside `isnull`
 * is not read as a literal.
 */
function notInWord(source: string, index: number): boolean {
  return index === 0 || !/[A-Za-z0-9_]/.test(source[index - 1]);
}

function keywordClassifier(words: Set<string>, kind: TokenKind = "keyword") {
  return (text: string): TokenKind => (words.has(text) ? kind : "plain");
}

// ───────────────────────────── JavaScript family ─────────────────────────────

// prettier-ignore
const JS_KEYWORDS = new Set([
  "abstract", "any", "as", "asserts", "async", "await", "bigint", "boolean",
  "break", "case", "catch", "class", "const", "constructor", "continue",
  "debugger", "declare", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "infer", "instanceof", "interface", "is",
  "keyof", "let", "namespace", "never", "new", "null", "number", "object",
  "of", "override", "private", "protected", "public", "readonly", "return",
  "satisfies", "set", "static", "string", "super", "switch", "symbol", "this",
  "throw", "true", "try", "type", "typeof", "undefined", "unknown", "var",
  "void", "while", "with", "yield",
]);

const JS_RULES: Rule[] = [
  { re: /\/\/[^\n]*/y, kind: "comment" },
  { re: /\/\*[\s\S]*?(?:\*\/|$)/y, kind: "comment" },
  { re: /`(?:\\[\s\S]|[^`\\])*`?/y, kind: "string" },
  { re: /"(?:\\[^\n]|[^"\\\n])*"?/y, kind: "string" },
  { re: /'(?:\\[^\n]|[^'\\\n])*'?/y, kind: "string" },
  {
    re: /0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\.\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?/y,
    kind: "number",
  },
  {
    re: /[A-Za-z_$][A-Za-z0-9_$]*/y,
    kind: "plain",
    classify: keywordClassifier(JS_KEYWORDS),
  },
  { re: /[{}()[\];,.:?!<>=+\-*/%&|^~@#]/y, kind: "punctuation" },
];

// ──────────────────────────────────── JSON ───────────────────────────────────

const JSON_RULES: Rule[] = [
  // A key is a string too, but colouring it separately is what makes a config
  // file skimmable at a glance.
  { re: /"(?:\\[^\n]|[^"\\\n])*"(?=[ \t]*:)/y, kind: "attr" },
  { re: /"(?:\\[^\n]|[^"\\\n])*"?/y, kind: "string" },
  { re: /(?:true|false|null)(?![A-Za-z0-9_])/y, kind: "keyword", where: notInWord },
  { re: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y, kind: "number" },
  { re: /[{}[\],:]/y, kind: "punctuation" },
];

// ────────────────────────────────── Markdown ─────────────────────────────────

const MD_RULES: Rule[] = [
  { re: /```[\s\S]*?(?:\n```|$)/y, kind: "string", atLineStart: true },
  { re: /~~~[\s\S]*?(?:\n~~~|$)/y, kind: "string", atLineStart: true },
  { re: /#{1,6}[^\n]*/y, kind: "keyword", atLineStart: true },
  { re: /[ \t]*(?:[-*+]|\d+\.)[ \t]+/y, kind: "punctuation", atLineStart: true },
  { re: /[ \t]*>[ \t]?/y, kind: "punctuation", atLineStart: true },
  { re: /`[^`\n]*`?/y, kind: "string" },
  { re: /\*\*[^\n]*?\*\*/y, kind: "attr" },
  { re: /__[^\n]*?__/y, kind: "attr" },
  { re: /\*[^*\n]+\*/y, kind: "attr" },
  { re: /!?\[[^\]\n]*\]/y, kind: "tag" },
];

// ──────────────────────────────────── CSS ────────────────────────────────────

const CSS_RULES: Rule[] = [
  { re: /\/\*[\s\S]*?(?:\*\/|$)/y, kind: "comment" },
  { re: /"(?:\\[^\n]|[^"\\\n])*"?/y, kind: "string" },
  { re: /'(?:\\[^\n]|[^'\\\n])*'?/y, kind: "string" },
  { re: /@[A-Za-z-]+/y, kind: "keyword" },
  { re: /--[A-Za-z0-9-]+/y, kind: "attr" },
  // Properties are recognised by sitting at the start of their own line, which
  // is how CSS is written in practice. Matching any `ident:` anywhere would
  // paint every `:hover` as a property.
  { re: /[ \t]*[A-Za-z-][A-Za-z0-9-]*(?=[ \t]*:)/y, kind: "attr", atLineStart: true },
  { re: /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])/y, kind: "number" },
  { re: /-?(?:\d+\.?\d*|\.\d+)(?:[A-Za-z%]+)?/y, kind: "number" },
  { re: /[A-Za-z_][A-Za-z0-9_-]*/y, kind: "plain" },
  { re: /[{}();:,.>+~*[\]="'#|^$!/]/y, kind: "punctuation" },
];

// ──────────────────────────────────── HTML ───────────────────────────────────

const HTML_RULES: Rule[] = [
  { re: /<!--[\s\S]*?(?:-->|$)/y, kind: "comment" },
  { re: /<!DOCTYPE[^>\n]*>?/iy, kind: "keyword" },
  { re: /<\/?[A-Za-z][A-Za-z0-9:.-]*/y, kind: "tag" },
  { re: /"[^"\n]*"?/y, kind: "string" },
  { re: /'[^'\n]*'?/y, kind: "string" },
  { re: /[A-Za-z_:][A-Za-z0-9_:.-]*(?==)/y, kind: "attr" },
  // Consumes the rest of a word once the lookahead above has failed. Without
  // it the attribute rule re-scans the same run at every offset inside it —
  // quadratic on one long unbroken token (a base64 payload, a hash, a `data:`
  // URL), which is exactly the shape of thing that ends up inline in HTML.
  { re: /[A-Za-z_:][A-Za-z0-9_:.-]*/y, kind: "plain" },
  { re: /&[A-Za-z0-9#]+;/y, kind: "number" },
  { re: /\/?>|[=/]/y, kind: "punctuation" },
];

// ─────────────────────────────────── Python ──────────────────────────────────

// prettier-ignore
const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "False", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "match", "None", "nonlocal", "not",
  "or", "pass", "raise", "return", "self", "True", "try", "while", "with",
  "yield",
]);

const PY_RULES: Rule[] = [
  { re: /#[^\n]*/y, kind: "comment" },
  { re: /[rRbBuUfF]{0,2}"""[\s\S]*?(?:"""|$)/y, kind: "string" },
  { re: /[rRbBuUfF]{0,2}'''[\s\S]*?(?:'''|$)/y, kind: "string" },
  { re: /[rRbBuUfF]{0,2}"(?:\\[^\n]|[^"\\\n])*"?/y, kind: "string" },
  { re: /[rRbBuUfF]{0,2}'(?:\\[^\n]|[^'\\\n])*'?/y, kind: "string" },
  {
    re: /0[xXbBoO][0-9a-fA-F_]+|\.\d[\d_]*|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?/y,
    kind: "number",
  },
  {
    re: /[A-Za-z_][A-Za-z0-9_]*/y,
    kind: "plain",
    classify: keywordClassifier(PY_KEYWORDS),
  },
  { re: /[{}()[\];,.:=+\-*/%<>!&|^~@]/y, kind: "punctuation" },
];

// ───────────────────────────────────── Go ────────────────────────────────────

// prettier-ignore
const GO_KEYWORDS = new Set([
  "append", "bool", "break", "byte", "cap", "case", "chan", "const", "continue",
  "copy", "default", "defer", "delete", "else", "error", "fallthrough", "false",
  "float32", "float64", "for", "func", "go", "goto", "if", "import", "int",
  "int32", "int64", "interface", "iota", "len", "make", "map", "new", "nil",
  "package", "panic", "range", "recover", "return", "rune", "select", "string",
  "struct", "switch", "true", "type", "uint", "uint64", "var",
]);

const GO_RULES: Rule[] = [
  { re: /\/\/[^\n]*/y, kind: "comment" },
  { re: /\/\*[\s\S]*?(?:\*\/|$)/y, kind: "comment" },
  { re: /`[^`]*`?/y, kind: "string" },
  { re: /"(?:\\[^\n]|[^"\\\n])*"?/y, kind: "string" },
  { re: /'(?:\\[^\n]|[^'\\\n])*'?/y, kind: "string" },
  {
    re: /0[xXbBoO][0-9a-fA-F_]+|\.\d[\d_]*|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?i?/y,
    kind: "number",
  },
  {
    re: /[A-Za-z_][A-Za-z0-9_]*/y,
    kind: "plain",
    classify: keywordClassifier(GO_KEYWORDS),
  },
  { re: /[{}()[\];,.:=+\-*/%<>!&|^~]/y, kind: "punctuation" },
];

// ──────────────────────────────────── Shell ──────────────────────────────────

// prettier-ignore
const SH_KEYWORDS = new Set([
  "break", "case", "continue", "declare", "do", "done", "elif", "else", "esac",
  "eval", "exec", "exit", "export", "fi", "for", "function", "if", "in",
  "local", "readonly", "return", "select", "set", "shift", "source", "then",
  "trap", "unset", "until", "while",
]);

const SH_RULES: Rule[] = [
  // `$#` and `${x#y}` both contain a hash that starts no comment, so the rule
  // only fires where a word could begin.
  { re: /#[^\n]*/y, kind: "comment", where: afterWhitespace },
  { re: /"(?:\\[\s\S]|[^"\\])*"?/y, kind: "string" },
  { re: /'[^']*'?/y, kind: "string" },
  { re: /\$\{[^}\n]*\}?|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]/y, kind: "attr" },
  { re: /\d+/y, kind: "number" },
  {
    re: /[A-Za-z_][A-Za-z0-9_]*/y,
    kind: "plain",
    classify: keywordClassifier(SH_KEYWORDS),
  },
  { re: /[{}()[\];,.:=+\-*/%<>!&|^~]/y, kind: "punctuation" },
];

// ──────────────────────────────────── YAML ───────────────────────────────────

const YAML_RULES: Rule[] = [
  { re: /#[^\n]*/y, kind: "comment", where: afterWhitespace },
  { re: /[ \t]*-[ \t]+/y, kind: "punctuation", atLineStart: true },
  { re: /---|\.\.\./y, kind: "punctuation", atLineStart: true },
  {
    re: /[A-Za-z_][A-Za-z0-9_./-]*(?=[ \t]*:(?:[ \t]|$|\n))/y,
    kind: "attr",
    where: afterWhitespace,
  },
  { re: /"(?:\\[^\n]|[^"\\\n])*"?/y, kind: "string" },
  { re: /'[^'\n]*'?/y, kind: "string" },
  {
    re: /(?:true|false|null|True|False|Null|yes|no|on|off)(?![A-Za-z0-9_-])/y,
    kind: "keyword",
    where: notInWord,
  },
  {
    re: /-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?(?![A-Za-z0-9_-])/y,
    kind: "number",
    where: notInWord,
  },
  { re: /[&*][A-Za-z0-9_-]+/y, kind: "attr" },
  { re: /[{}[\],:|>?]/y, kind: "punctuation" },
];

// ──────────────────────────────────── SQL ────────────────────────────────────

// prettier-ignore
const SQL_KEYWORDS = new Set([
  "ADD", "ALL", "ALTER", "AND", "AS", "ASC", "AVG", "BEGIN", "BETWEEN",
  "BOOLEAN", "BY", "CASE", "CAST", "CHECK", "COALESCE", "COLUMN", "COMMIT",
  "CONSTRAINT", "COUNT", "CREATE", "CROSS", "DATE", "DEFAULT", "DELETE",
  "DESC", "DISTINCT", "DROP", "ELSE", "END", "EXISTS", "FOREIGN", "FROM",
  "FULL", "GROUP", "HAVING", "IF", "IN", "INDEX", "INNER", "INSERT", "INT",
  "INTEGER", "INTO", "IS", "JOIN", "KEY", "LEFT", "LIKE", "LIMIT", "MAX",
  "MIN", "NOT", "NULL", "OFFSET", "ON", "OR", "ORDER", "OUTER", "PRIMARY",
  "REFERENCES", "RENAME", "RETURNING", "RIGHT", "ROLLBACK", "SELECT", "SERIAL",
  "SET", "SUM", "TABLE", "TEXT", "THEN", "TIMESTAMP", "TO", "TRANSACTION",
  "UNION", "UNIQUE", "UPDATE", "VALUES", "VARCHAR", "VIEW", "WHEN", "WHERE",
  "WITH",
]);

const SQL_RULES: Rule[] = [
  { re: /--[^\n]*/y, kind: "comment" },
  { re: /\/\*[\s\S]*?(?:\*\/|$)/y, kind: "comment" },
  { re: /'(?:''|[^'])*'?/y, kind: "string" },
  { re: /"(?:""|[^"\n])*"?/y, kind: "string" },
  { re: /`[^`\n]*`?/y, kind: "string" },
  { re: /\d+(?:\.\d+)?/y, kind: "number" },
  {
    re: /[A-Za-z_][A-Za-z0-9_$]*/y,
    kind: "plain",
    classify: (text) => (SQL_KEYWORDS.has(text.toUpperCase()) ? "keyword" : "plain"),
  },
  { re: /[{}()[\];,.:=+\-*/%<>!&|^~]/y, kind: "punctuation" },
];

/**
 * Whitespace is plain in every grammar, and matching it in runs rather than a
 * character at a time is what keeps a large file cheap to tokenize. Newlines are
 * matched separately so the `atLineStart` rules above still see a line boundary.
 */
const WHITESPACE_RULES: Rule[] = [
  { re: /\n+/y, kind: "plain" },
  { re: /[^\S\n]+/y, kind: "plain" },
];

const GRAMMARS: Record<string, Rule[]> = {
  css: CSS_RULES,
  go: GO_RULES,
  html: HTML_RULES,
  js: JS_RULES,
  json: JSON_RULES,
  jsx: JS_RULES,
  md: MD_RULES,
  py: PY_RULES,
  sh: SH_RULES,
  sql: SQL_RULES,
  ts: JS_RULES,
  tsx: JS_RULES,
  yaml: YAML_RULES,
};

/** Every language id {@link highlight} knows a grammar for. */
export const SUPPORTED_LANGUAGES: string[] = Object.keys(GRAMMARS).sort();

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: "sh",
  cjs: "js",
  css: "css",
  cts: "ts",
  go: "go",
  htm: "html",
  html: "html",
  js: "js",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  markdown: "md",
  md: "md",
  mdx: "md",
  mjs: "js",
  mts: "ts",
  py: "py",
  sh: "sh",
  sql: "sql",
  ts: "ts",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zsh: "sh",
};

/**
 * The language id for a path, or `"plain"` when nothing is known about it.
 * A leading-dot filename (`.gitignore`) has no extension and stays plain.
 */
export function languageForPath(path: string): string {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return EXTENSION_LANGUAGES[extension] ?? "plain";
}

/** Fold neighbouring tokens of the same kind together, and drop empty ones. */
function merge(tokens: Token[]): Token[] {
  const merged: Token[] = [];
  for (const token of tokens) {
    if (!token.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.kind === token.kind) previous.text += token.text;
    else merged.push({ text: token.text, kind: token.kind });
  }
  return merged;
}

function scan(source: string, rules: Rule[]): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let plainFrom = 0;

  while (index < source.length) {
    const lineStart = index === 0 || source[index - 1] === "\n";
    let advanced = false;

    for (const rule of rules) {
      if (rule.atLineStart && !lineStart) continue;
      if (rule.where && !rule.where(source, index)) continue;
      rule.re.lastIndex = index;
      const match = rule.re.exec(source);
      // A zero-length match would never advance the cursor; skipping it is what
      // keeps an over-permissive pattern from hanging the editor.
      if (!match || match.index !== index || match[0].length === 0) continue;

      if (index > plainFrom) tokens.push({ text: source.slice(plainFrom, index), kind: "plain" });
      tokens.push({
        text: match[0],
        kind: rule.classify ? rule.classify(match[0]) : rule.kind,
      });
      index += match[0].length;
      plainFrom = index;
      advanced = true;
      break;
    }

    if (!advanced) index += 1;
  }

  if (source.length > plainFrom) {
    tokens.push({ text: source.slice(plainFrom), kind: "plain" });
  }
  return merge(tokens);
}

/**
 * Tokenize `source` for `language`. An unknown language — or an empty grammar
 * match anywhere — degrades to plain text rather than failing.
 */
export function highlight(source: string, language: string): Token[] {
  if (!source) return [];
  const rules = GRAMMARS[language];
  if (!rules) return [{ text: source, kind: "plain" }];
  return scan(source, [...rules, ...WHITESPACE_RULES]);
}
