import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  editDistance,
  kebabCase,
  normalizeName,
  parseItem,
  suggest,
  tokenize,
  walk,
  type FlagMeaning,
  type Token,
} from "./argv.js";
import { CliError } from "./errors.js";
import { findOption, GLOBAL_OPTIONS, REQUEST_OPTIONS } from "./options.js";

const OPTIONS = [...GLOBAL_OPTIONS, ...REQUEST_OPTIONS];

function optionsOnly(token: Extract<Token, { type: "flag" }>): FlagMeaning {
  const option = findOption(OPTIONS, token.name, token.short);
  return option ? { kind: "option", option } : { kind: "unknown" };
}

function rejectUnknown(token: Extract<Token, { type: "flag" }>): never {
  throw new CliError("usage", `unknown ${token.raw}`);
}

describe("tokenize", () => {
  test("splits long flags, values after =, short flags and words", () => {
    assert.deepEqual(tokenize(["--json", "--select=id", "-v", "call", "x=1"]), [
      { type: "flag", name: "json", short: false, raw: "--json" },
      { type: "flag", name: "select", short: false, value: "id", raw: "--select=id" },
      { type: "flag", name: "v", short: true, raw: "-v" },
      { type: "word", value: "call", afterEnd: false },
      { type: "word", value: "x=1", afterEnd: false },
    ]);
  });

  test("keeps everything after -- as words, even dashes", () => {
    assert.deepEqual(tokenize(["a", "--", "--json", "-v", "k=v"]), [
      { type: "word", value: "a", afterEnd: false },
      { type: "word", value: "--json", afterEnd: true },
      { type: "word", value: "-v", afterEnd: true },
      { type: "word", value: "k=v", afterEnd: true },
    ]);
  });

  test("treats a lone dash and negative numbers as words", () => {
    assert.deepEqual(
      tokenize(["-", "-5", "-0.5"]).map((token) => token.type),
      ["word", "word", "word"],
    );
  });

  test("keeps an empty value after = and = inside values", () => {
    const [empty, inner] = tokenize(["--select=", "--data={\"a\":\"b=c\"}"]);
    assert.equal(empty.type === "flag" && empty.value, "");
    assert.equal(inner.type === "flag" && inner.value, '{"a":"b=c"}');
  });
});

describe("walk", () => {
  test("reads options with values from the next token or after =", () => {
    const result = walk(tokenize(["--select", "id", "-d", "{}", "--output=out.json"]), optionsOnly, {
      onUnknown: rejectUnknown,
    });
    assert.equal(result.options.get("select"), "id");
    assert.equal(result.options.get("data"), "{}");
    assert.equal(result.options.get("output"), "out.json");
  });

  test("takes a value verbatim, even one that looks like a flag or stdin", () => {
    const result = walk(tokenize(["--data", "-", "--select", "--weird"]), optionsOnly, {
      onUnknown: rejectUnknown,
    });
    assert.equal(result.options.get("data"), "-");
    assert.equal(result.options.get("select"), "--weird");
  });

  test("fails when a value is missing at the end", () => {
    assert.throws(
      () => walk(tokenize(["--select"]), optionsOnly, { onUnknown: rejectUnknown }),
      (error: unknown) => error instanceof CliError && error.kind === "usage" && /needs a value/.test(error.message),
    );
  });

  test("reads switches, with explicit true and false values", () => {
    const result = walk(tokenize(["--json", "--all=false", "--dry-run=yes"]), optionsOnly, {
      onUnknown: rejectUnknown,
    });
    assert.equal(result.options.get("json"), true);
    assert.equal(result.options.get("all"), false);
    assert.equal(result.options.get("dry-run"), true);
  });

  test("refuses a switch given a value that is not yes or no", () => {
    assert.throws(
      () => walk(tokenize(["--json=maybe"]), optionsOnly, { onUnknown: rejectUnknown }),
      /is a switch/,
    );
  });

  test("hands unknown flags to onUnknown", () => {
    assert.throws(
      () => walk(tokenize(["--nope"]), optionsOnly, { onUnknown: rejectUnknown }),
      /unknown --nope/,
    );
  });

  test("stops at the first word when asked, returning the rest untouched", () => {
    const result = walk(tokenize(["--json", "call", "--title", "x"]), optionsOnly, {
      stopAtWord: true,
      onUnknown: rejectUnknown,
    });
    assert.equal(result.stoppedAt, "call");
    assert.equal(result.options.get("json"), true);
    assert.deepEqual(
      result.rest.map((token) => (token.type === "flag" ? token.raw : token.value)),
      ["--title", "x"],
    );
  });

  test("does not stop at a word after --", () => {
    const result = walk(tokenize(["--", "call"]), optionsOnly, {
      stopAtWord: true,
      onUnknown: rejectUnknown,
    });
    assert.equal(result.stoppedAt, undefined);
    assert.deepEqual(result.words, [{ value: "call", afterEnd: true }]);
  });

  test("reads parameter flags: values, switches and negations", () => {
    const meaning = (token: Extract<Token, { type: "flag" }>): FlagMeaning => {
      if (token.name === "title") return { kind: "param", takes: "value" };
      if (token.name === "archived") return { kind: "param", takes: "switch" };
      if (token.name === "no-archived") return { kind: "param", takes: "negated", name: "archived" };
      return optionsOnly(token);
    };
    const result = walk(
      tokenize(["--title", "Q3", "--archived", "--archived", "false", "--no-archived", "--archived=1", "rid"]),
      meaning,
      { onUnknown: rejectUnknown },
    );
    assert.deepEqual(
      result.params.map(({ name, value }) => [name, value]),
      [
        ["title", "Q3"],
        ["archived", true],
        ["archived", false],
        ["archived", false],
        ["archived", true],
      ],
    );
    assert.deepEqual(result.words, [{ value: "rid", afterEnd: false }]);
  });

  test("a switch does not swallow a following word that is not true or false", () => {
    const meaning = (): FlagMeaning => ({ kind: "param", takes: "switch" });
    const result = walk(tokenize(["--archived", "abc"]), meaning, { onUnknown: rejectUnknown });
    assert.deepEqual(result.params[0].value, true);
    assert.deepEqual(result.words, [{ value: "abc", afterEnd: false }]);
  });

  test("a negated switch takes no value", () => {
    const meaning = (): FlagMeaning => ({ kind: "param", takes: "negated", name: "archived" });
    assert.throws(
      () => walk(tokenize(["--no-archived=true"]), meaning, { onUnknown: rejectUnknown }),
      /takes no value/,
    );
  });

  test("accumulates into an existing option map", () => {
    const into = new Map<string, string | boolean>([["json", true]]);
    walk(tokenize(["--select", "id"]), optionsOnly, { onUnknown: rejectUnknown, into });
    assert.deepEqual([...into.entries()], [
      ["json", true],
      ["select", "id"],
    ]);
  });
});

describe("parseItem", () => {
  test("reads name=value and name:=json", () => {
    assert.deepEqual(parseItem("title=Q3 plan"), {
      name: "title",
      value: "Q3 plan",
      json: false,
      raw: "title=Q3 plan",
    });
    assert.deepEqual(parseItem("amountCents:=1200"), {
      name: "amountCents",
      value: "1200",
      json: true,
      raw: "amountCents:=1200",
    });
  });

  test("splits at the first = and keeps the rest", () => {
    assert.equal(parseItem("note=a=b")?.value, "a=b");
    assert.equal(parseItem("note=")?.value, "");
    assert.equal(parseItem("expr:=a:=b")?.value, "a:=b");
  });

  test("accepts kebab and dotted names", () => {
    assert.equal(parseItem("amount-cents=5")?.name, "amount-cents");
    assert.equal(parseItem("meta.tier=gold")?.name, "meta.tier");
  });

  test("leaves words that are not items", () => {
    assert.equal(parseItem("3f2c-uuid"), null);
    assert.equal(parseItem("=value"), null);
    assert.equal(parseItem("1abc=x"), null);
    assert.equal(parseItem("a:b=c"), null);
    assert.equal(parseItem("https://example.com/?a=b"), null);
  });
});

describe("names", () => {
  test("kebab-cases operation ids and parameter names", () => {
    assert.equal(kebabCase("listRevenueDeals"), "list-revenue-deals");
    assert.equal(kebabCase("amountCents"), "amount-cents");
    assert.equal(kebabCase("getV2Thing"), "get-v2-thing");
    assert.equal(kebabCase("parse_HTMLDoc"), "parse-html-doc");
    assert.equal(kebabCase("already-kebab"), "already-kebab");
  });

  test("normalizes away case and separators", () => {
    assert.equal(normalizeName("amount-cents"), normalizeName("amountCents"));
    assert.equal(normalizeName("amount_cents"), "amountcents");
  });

  test("measures edit distance", () => {
    assert.equal(editDistance("kitten", "sitting"), 3);
    assert.equal(editDistance("", "abc"), 3);
    assert.equal(editDistance("same", "same"), 0);
  });

  test("suggests close names, prefixes first, at most three", () => {
    const titles = suggest("titel", ["status", "total", "title"]);
    assert.equal(titles[0], "title");
    assert.ok(!titles.includes("status"));
    assert.deepEqual(suggest("amount", ["amount-cents", "account"]), ["amount-cents", "account"]);
    assert.deepEqual(suggest("zzzz", ["title", "status"]), []);
    assert.ok(suggest("a", ["ab", "ac", "ad", "ae"]).length <= 3);
    assert.deepEqual(suggest("", ["title"]), []);
  });
});
