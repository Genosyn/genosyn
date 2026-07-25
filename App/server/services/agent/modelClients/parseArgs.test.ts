import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PARSE_ERROR_KEY, parseArgs } from "./parseArgs.js";

describe("parseArgs", () => {
  test("parses an ordinary object and preserves nested values", () => {
    assert.deepEqual(parseArgs('{"name":"Ada","nested":{"ok":true},"count":2}'), {
      input: { name: "Ada", nested: { ok: true }, count: 2 },
    });
  });

  test("treats blank input as an argument-less call", () => {
    assert.deepEqual(parseArgs(""), { input: {} });
    assert.deepEqual(parseArgs(" \n\t "), { input: {} });
  });

  test("reports malformed JSON in both result channels", () => {
    const out = parseArgs('{"name":');
    assert.match(out.parseError ?? "", /not valid JSON/);
    assert.equal(out.input[PARSE_ERROR_KEY], out.parseError);
    assert.match(out.parseError ?? "", /Received: \{"name":/);
  });

  test("rejects every valid JSON value that is not an object", () => {
    for (const [raw, kind] of [
      ["null", "object"],
      ["[]", "an array"],
      ['"text"', "string"],
      ["42", "number"],
      ["true", "boolean"],
    ]) {
      const out = parseArgs(raw);
      assert.match(out.parseError ?? "", new RegExp(`parsed to ${kind}`));
      assert.equal(out.input[PARSE_ERROR_KEY], out.parseError);
    }
  });

  test("clips a long corrupt payload before echoing it to a transcript", () => {
    const raw = `{"value":"${"x".repeat(500)}`;
    const out = parseArgs(raw);
    assert.ok((out.parseError ?? "").length < 350);
    assert.match(out.parseError ?? "", /…$/);
  });
});
