import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  RevenueImportSourceParseError,
  parseRevenueCsvSource,
  parseRevenueImportSource,
  parseRevenueJsonSource,
  parseRevenueNdjsonSource,
} from "./importSources.js";

function hasCode(code: RevenueImportSourceParseError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof RevenueImportSourceParseError && error.code === code;
}

describe("Revenue import file parsers", () => {
  test("parses BOM-prefixed RFC-style CSV with stable source IDs and multiline cells", () => {
    const parsed = parseRevenueCsvSource(
      '\ufeffexternal_id,Name,Notes\r\ncrm-1,"Acme, Inc","Line 1\r\nLine 2"\r\ncrm-2,Globex,"Said ""hello"""\r\n',
      { sourceIdField: "external_id" },
    );

    assert.deepEqual(parsed.fields, ["external_id", "Name", "Notes"]);
    assert.deepEqual(
      parsed.rows.map((row) => row.sourceId),
      ["crm-1", "crm-2"],
    );
    assert.equal(parsed.rows[0].values.Name, "Acme, Inc");
    assert.equal(parsed.rows[0].values.Notes, "Line 1\r\nLine 2");
    assert.equal(parsed.rows[1].values.Notes, 'Said "hello"');
  });

  test("uses deterministic physical-line IDs when a CSV source ID column is not configured", () => {
    const parsed = parseRevenueCsvSource(
      "Name,Email\nAcme,a@example.com\n\nGlobex,g@example.com\n",
    );
    assert.deepEqual(
      parsed.rows.map((row) => row.sourceId),
      ["csv:2", "csv:4"],
    );
  });

  test("rejects duplicate headers and malformed CSV quoting", () => {
    assert.throws(
      () => parseRevenueCsvSource("Name,name\nAcme,Other\n"),
      hasCode("duplicate_header"),
    );
    assert.throws(
      () => parseRevenueCsvSource('Name,Notes\nAcme,"never closed\n'),
      hasCode("malformed_csv"),
    );
    assert.throws(
      () => parseRevenueCsvSource('Name,Notes\nAcme,"closed"tail\n'),
      hasCode("malformed_csv"),
    );
  });

  test("parses JSON arrays in object and explicit ImportRow form", () => {
    const parsed = parseRevenueJsonSource(
      '\ufeff[{"name":"Acme","score":80},{"sourceId":"crm:2","values":{"name":"Globex","score":90}}]',
    );

    assert.deepEqual(parsed.fields, ["name", "score"]);
    assert.equal(parsed.rows[0].sourceId, "json:1");
    assert.equal(parsed.rows[1].sourceId, "crm:2");
    assert.deepEqual(parsed.rows[1].values, { name: "Globex", score: 90 });
  });

  test("parses NDJSON with physical-line IDs and preserves explicit source IDs", () => {
    const parsed = parseRevenueImportSource(
      "ndjson",
      '{"name":"Acme"}\n\n{"sourceId":"crm:three","values":{"name":"Initech","active":true}}\n',
    );

    assert.deepEqual(parsed.fields, ["name", "active"]);
    assert.deepEqual(
      parsed.rows.map((row) => row.sourceId),
      ["ndjson:1", "crm:three"],
    );
    assert.equal(parsed.rows[1].values.active, true);
  });

  test("validates configured and explicit source IDs for presence and uniqueness", () => {
    assert.throws(
      () =>
        parseRevenueJsonSource('[{"external":"same"},{"external":"same"}]', {
          sourceIdField: "external",
        }),
      hasCode("duplicate_source_id"),
    );
    assert.throws(
      () => parseRevenueJsonSource('[{"name":"Acme"}]', { sourceIdField: "external" }),
      hasCode("invalid_source_id"),
    );
    assert.throws(
      () => parseRevenueNdjsonSource('{"sourceId":" padded ","values":{"name":"Acme"}}\n'),
      hasCode("invalid_source_id"),
    );
  });

  test("enforces byte, row, and column bounds before returning rows", () => {
    assert.throws(
      () => parseRevenueCsvSource("Name\nAcme\n", { maxBytes: 5 }),
      hasCode("input_too_large"),
    );
    assert.throws(
      () => parseRevenueJsonSource('[{"name":"A"},{"name":"B"}]', { maxRows: 1 }),
      hasCode("too_many_rows"),
    );
    assert.throws(
      () => parseRevenueNdjsonSource('{"one":1,"two":2}\n', { maxColumns: 1 }),
      hasCode("too_many_columns"),
    );
  });
});
