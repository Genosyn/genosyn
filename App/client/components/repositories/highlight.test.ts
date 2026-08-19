import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { SUPPORTED_LANGUAGES, Token, highlight, languageForPath } from "./highlight";

/**
 * The round-trip property at the bottom is the one that matters. The tokens are
 * painted underneath the textarea people type into, so losing or duplicating a
 * single character silently shifts every following line of the overlay.
 * Everything above it is about the colours being useful; that one is about the
 * editor staying honest.
 */

function textOf(tokens: Token[]): string {
  return tokens.map((token) => token.text).join("");
}

function kindOf(tokens: Token[], text: string): string | undefined {
  return tokens.find((token) => token.text === text)?.kind;
}

const SAMPLES: Record<string, string> = {
  ts: `// boot the server\nimport express from "express";\n\n/* multi\n   line */\nexport const PORT = 0x1f3 + 42.5;\nconst greet = (name: string) => \`hi \${name}\`;\nclass A extends B { private x = null; }\n`,
  tsx: `export function Badge({ label }: { label: string }) {\n  return <span className="badge">{label}</span>;\n}\n`,
  js: `const total = [1, 2, 3].reduce((sum, n) => sum + n, 0);\nif (!total) throw new Error('empty');\n`,
  jsx: `const App = () => <div title='x'>{/* hi */}</div>;\n`,
  json: `{\n  "name": "genosyn",\n  "version": 2,\n  "private": true,\n  "tags": [null, "a", 1.5e3],\n  "nested": { "deep": false }\n}\n`,
  md: `# Title\n\nSome **bold** and *italic* text with \`code\`.\n\n- one\n- two\n\n> quoted\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n[link](https://example.com)\n`,
  css: `/* theme */\n:root {\n  --brand: #4f46e5;\n  color: rgb(0 0 0 / 50%);\n}\n.card:hover > a[href="#x"] {\n  margin: 0 auto 1.5rem;\n}\n@media (min-width: 40em) { .card { display: none; } }\n`,
  html: `<!DOCTYPE html>\n<!-- a note -->\n<html lang="en">\n  <body class='x' hidden>\n    <p>Hello &amp; welcome</p>\n    <img src="a.png" />\n  </body>\n</html>\n`,
  py: `#!/usr/bin/env python\n"""Module docstring."""\nimport os\n\n\nclass Thing:\n    def __init__(self, name: str = 'x'):\n        self.name = name\n        self.count = 0b1010 + 3.14\n\n    def run(self):\n        if not self.name:\n            raise ValueError(f"bad {self.name}")\n        return None\n`,
  go: `package main\n\nimport "fmt"\n\n// Entry point.\nfunc main() {\n\tconst n = 0x2a\n\ts := \`raw\nstring\`\n\tfor i := 0; i < n; i++ {\n\t\tfmt.Println(s, 'x', 1.5)\n\t}\n}\n`,
  sh: `#!/bin/sh\nset -eu\n\n# deploy\nNAME="\${1:-app}"\nfor i in 1 2 3; do\n  echo "run $i of $NAME" # trailing note\ndone\n\nif [ -z "$NAME" ]; then\n  exit 1\nfi\n`,
  yaml: `# config\nversion: 2\nname: "genosyn"\nenabled: true\nempty: null\nservices:\n  - name: web\n    port: 8080\n    tags: [a, b]\nanchors: &base\n  retries: 3\n`,
  sql: `-- recent rows\nSELECT id, name, COUNT(*) AS total\nFROM users u\nLEFT JOIN orders o ON o.user_id = u.id\nWHERE u.name LIKE 'a%' AND u.age > 21\nGROUP BY 1, 2\nORDER BY total DESC\nLIMIT 100;\n/* done */\n`,
};

describe("languageForPath", () => {
  test("maps the extensions the editor highlights", () => {
    assert.equal(languageForPath("src/app.ts"), "ts");
    assert.equal(languageForPath("src/App.TSX"), "tsx");
    assert.equal(languageForPath("scripts/build.mjs"), "js");
    assert.equal(languageForPath("package.json"), "json");
    assert.equal(languageForPath("docs/README.md"), "md");
    assert.equal(languageForPath("deploy/values.yml"), "yaml");
    assert.equal(languageForPath("bin/run.sh"), "sh");
  });

  test("falls back to plain for anything it does not know", () => {
    assert.equal(languageForPath("notes.xyz"), "plain");
    assert.equal(languageForPath("Dockerfile"), "plain");
    assert.equal(languageForPath(".gitignore"), "plain");
    assert.equal(languageForPath(""), "plain");
  });
});

describe("highlight — TypeScript", () => {
  const tokens = highlight(SAMPLES.ts, "ts");

  test("marks keywords", () => {
    assert.equal(kindOf(tokens, "import"), "keyword");
    assert.equal(kindOf(tokens, "const"), "keyword");
    assert.equal(kindOf(tokens, "class"), "keyword");
    assert.equal(kindOf(tokens, "null"), "keyword");
  });

  test("marks strings, including template literals", () => {
    assert.equal(kindOf(tokens, '"express"'), "string");
    assert.equal(kindOf(tokens, "`hi ${name}`"), "string");
  });

  test("marks line and block comments", () => {
    assert.equal(kindOf(tokens, "// boot the server"), "comment");
    assert.equal(kindOf(tokens, "/* multi\n   line */"), "comment");
  });

  test("marks numbers, hex included", () => {
    assert.equal(kindOf(tokens, "0x1f3"), "number");
    assert.equal(kindOf(tokens, "42.5"), "number");
  });

  test("does not mistake a number for the tail of an identifier", () => {
    const identifiers = highlight("const utf8 = base64;", "ts");
    assert.deepEqual(
      identifiers.filter((token) => token.kind === "number"),
      [],
    );
  });
});

describe("highlight — JSON", () => {
  const tokens = highlight(SAMPLES.json, "json");

  test("separates keys from string values", () => {
    assert.equal(kindOf(tokens, '"name"'), "attr");
    assert.equal(kindOf(tokens, '"genosyn"'), "string");
  });

  test("marks literals and numbers", () => {
    assert.equal(kindOf(tokens, "true"), "keyword");
    assert.equal(kindOf(tokens, "null"), "keyword");
    assert.equal(kindOf(tokens, "1.5e3"), "number");
  });

  test("emits nothing but plain text for an empty document", () => {
    assert.deepEqual(highlight("", "json"), []);
  });
});

describe("highlight — unterminated input", () => {
  test("a string with no closing quote stops at the end of its line", () => {
    const source = 'const a = "oops\nconst b = 2;\n';
    const tokens = highlight(source, "ts");
    assert.equal(kindOf(tokens, '"oops'), "string");
    assert.equal(kindOf(tokens, "const"), "keyword");
    assert.equal(textOf(tokens), source);
  });

  test("a template literal with no closing backtick runs to the end", () => {
    const source = "const a = `oops\nstill inside";
    const tokens = highlight(source, "ts");
    assert.equal(kindOf(tokens, "`oops\nstill inside"), "string");
    assert.equal(textOf(tokens), source);
  });

  test("an unclosed block comment runs to the end", () => {
    const source = "/* forever\nand ever";
    assert.deepEqual(highlight(source, "ts"), [{ text: source, kind: "comment" }]);
  });

  test("an unclosed markdown fence runs to the end", () => {
    const source = "```ts\nconst x = 1;\n";
    assert.equal(textOf(highlight(source, "md")), source);
  });
});

describe("highlight — one long unbroken word", () => {
  // The HTML attribute rule ends in a lookahead. Without a plain-word rule
  // behind it the scanner retried the whole run at every offset inside it,
  // which took 34 s on a file at the editor's highlight cap. The bound below
  // is deliberately loose — the failure mode is seconds, not milliseconds.
  test("html does not degrade on a long run of word characters", () => {
    const source = `<p>${"aB0_.-:".repeat(9000)}</p>`;
    const started = Date.now();
    const tokens = highlight(source, "html");
    assert.equal(textOf(tokens), source);
    assert.ok(Date.now() - started < 1000, "html tokenizing took more than a second");
  });

  test("every grammar stays linear on the same input", () => {
    const source = "x".repeat(60_000);
    for (const language of SUPPORTED_LANGUAGES) {
      const started = Date.now();
      assert.equal(textOf(highlight(source, language)), source);
      assert.ok(Date.now() - started < 1000, `${language} tokenizing took more than a second`);
    }
  });
});

describe("highlight — unknown languages", () => {
  test("an unknown extension yields exactly one plain token", () => {
    const source = "anything at all\nwith 'quotes' and // slashes\n";
    const tokens = highlight(source, languageForPath("notes.xyz"));
    assert.deepEqual(tokens, [{ text: source, kind: "plain" }]);
  });

  test("an empty file yields no tokens at all", () => {
    assert.deepEqual(highlight("", "plain"), []);
    assert.deepEqual(highlight("", "ts"), []);
  });
});

describe("highlight — the text is never changed", () => {
  test("every supported language has a sample", () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), SUPPORTED_LANGUAGES);
  });

  for (const language of SUPPORTED_LANGUAGES) {
    test(`${language}: tokens concatenate back to the source`, () => {
      assert.equal(textOf(highlight(SAMPLES[language], language)), SAMPLES[language]);
    });
  }

  // Cross-feeding every sample through every grammar is the cheap way to reach
  // the states a real repository produces — a shell heredoc inside YAML, a JSON
  // blob pasted into markdown — without inventing a fixture for each one.
  for (const language of SUPPORTED_LANGUAGES) {
    test(`${language}: survives being fed every other language's sample`, () => {
      for (const [name, sample] of Object.entries(SAMPLES)) {
        assert.equal(
          textOf(highlight(sample, language)),
          sample,
          `${language} grammar mangled the ${name} sample`,
        );
      }
    });
  }

  test("awkward inputs still round-trip in every language", () => {
    const awkward = [
      "",
      "\n",
      "\n\n\n",
      "   ",
      "\t\t",
      "a",
      "'",
      '"',
      "`",
      "/*",
      "*/",
      "//",
      "#",
      "--",
      "<",
      ">",
      "0x",
      ".5",
      "-",
      "é中🚀",
      "\r\n\r\n",
      "key:\n  - 'unclosed\n",
      "<!-- unclosed",
      '{"a": ',
    ];
    for (const language of [...SUPPORTED_LANGUAGES, "plain", "made-up"]) {
      for (const source of awkward) {
        assert.equal(
          textOf(highlight(source, language)),
          source,
          `${language} mangled ${JSON.stringify(source)}`,
        );
      }
    }
  });
});
