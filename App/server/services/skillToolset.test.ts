import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseToolset,
  serializeToolset,
  validateToolset,
  MAX_TOOLSET_ENTRIES,
} from "./skillToolset.js";

describe("parseToolset", () => {
  test("reads a stored list", () => {
    assert.deepEqual(parseToolset('["send_invoice","record_payment"]'), [
      "send_invoice",
      "record_payment",
    ]);
  });
  test("null / empty / garbage all read as empty, never throwing", () => {
    assert.deepEqual(parseToolset(null), []);
    assert.deepEqual(parseToolset(""), []);
    assert.deepEqual(parseToolset("not json"), []);
    assert.deepEqual(parseToolset("[1,2,3]"), []);
    assert.deepEqual(parseToolset('{"a":1}'), []);
  });
});

describe("serializeToolset", () => {
  test("empty stores as null, not '[]'", () => {
    assert.equal(serializeToolset([]), null);
  });
  test("non-empty round-trips", () => {
    assert.deepEqual(parseToolset(serializeToolset(["send_invoice"])), ["send_invoice"]);
  });
});

describe("validateToolset", () => {
  test("accepts a real static tool", () => {
    const r = validateToolset(["send_invoice"]);
    assert.deepEqual(r, { ok: true, names: ["send_invoice"] });
  });

  test("accepts the live `memory` family, which is not a STATIC_TOOLS entry", () => {
    // Regression: knownToolNames must include the collapsed family names, or a
    // Skill declaring `memory` is a 400 for a tool that is always resident.
    assert.equal(validateToolset(["memory"]).ok, true);
  });

  test("accepts a retired family alias", () => {
    assert.equal(validateToolset(["mail"]).ok, true);
    assert.equal(validateToolset(["base_rows"]).ok, true);
  });

  test("accepts a coding tool", () => {
    assert.equal(validateToolset(["bash"]).ok, true);
  });

  test("accepts a company-MCP tool by shape (`server__tool`)", () => {
    // Regression: bridged MCP names are `<server>__<tool>`. The old `:` escape
    // never matched, so the declared-toolset hatch was unreachable for exactly
    // the tools with unguessable names.
    assert.equal(validateToolset(["notion__search"]).ok, true);
  });

  test("accepts an integration tool by shape (`provider_tool`)", () => {
    assert.equal(validateToolset(["stripe_create_charge"]).ok, true);
  });

  test("accepts a browser tool by shape", () => {
    assert.equal(validateToolset(["browser_click"]).ok, true);
  });

  test("rejects a typo of a static tool, with a suggestion", () => {
    const r = validateToolset(["send_invoic"]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /send_invoice/);
  });

  test("rejects obvious garbage", () => {
    assert.equal(validateToolset(["definitely not a tool!!!"]).ok, false);
  });

  test("counts the limit after dedupe and blank-strip, not before", () => {
    // MAX+5 entries that collapse (dupes + blanks) to a small real set is a
    // fine toolset, not an over-limit one.
    const withDupes = [
      ...Array(MAX_TOOLSET_ENTRIES + 5).fill("send_invoice"),
      "",
      "   ",
      "record_payment",
    ];
    const r = validateToolset(withDupes);
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.deepEqual(r.names, ["send_invoice", "record_payment"]);
  });

  test("rejects genuinely too many distinct tools", () => {
    const tooMany = Array.from({ length: MAX_TOOLSET_ENTRIES + 1 }, (_, i) => `notion__tool_${i}`);
    assert.equal(validateToolset(tooMany).ok, false);
  });

  test("non-array and non-string entries are rejected", () => {
    assert.equal(validateToolset("send_invoice" as unknown).ok, false);
    assert.equal(validateToolset([123] as unknown).ok, false);
  });
});
