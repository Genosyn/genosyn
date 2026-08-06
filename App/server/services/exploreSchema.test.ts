import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildExploreSchema, isExploreProvider, schemaSqlForProvider } from "./explore.js";

describe("Explore schema discovery SQL", () => {
  test("recognizes exactly the three supported database Connections", () => {
    assert.equal(isExploreProvider("postgres"), true);
    assert.equal(isExploreProvider("mysql"), true);
    assert.equal(isExploreProvider("clickhouse"), true);
    assert.equal(isExploreProvider("sqlite"), false);
    assert.equal(isExploreProvider("metabase"), false);
    assert.equal(isExploreProvider(""), false);
  });

  test("Postgres hides system and temporary schemas", () => {
    const sql = schemaSqlForProvider("postgres");
    assert.match(sql, /information_schema\.columns/);
    assert.match(sql, /information_schema\.tables/);
    assert.match(sql, /pg_catalog/);
    assert.match(sql, /pg_toast/);
    assert.match(sql, /pg_temp_%/);
    assert.match(sql, /ORDER BY c\.table_schema, c\.table_name, c\.ordinal_position/);
  });

  test("MySQL stays inside the Connection's selected database", () => {
    const sql = schemaSqlForProvider("mysql");
    assert.match(sql, /c\.table_schema = DATABASE\(\)/);
    assert.match(sql, /c\.column_type AS data_type/);
    assert.match(sql, /t\.table_type AS table_kind/);
  });

  test("ClickHouse stays inside the current database and recognizes Nullable columns", () => {
    const sql = schemaSqlForProvider("clickhouse");
    assert.match(sql, /FROM system\.columns c/);
    assert.match(sql, /LEFT JOIN system\.tables t/);
    assert.match(sql, /c\.database = currentDatabase\(\)/);
    assert.match(sql, /startsWith\(c\.type, 'Nullable\('/);
  });

  test("every dialect aliases the normalized row contract", () => {
    for (const provider of ["postgres", "mysql", "clickhouse"] as const) {
      const sql = schemaSqlForProvider(provider);
      for (const alias of [
        "schema_name",
        "table_name",
        "table_kind",
        "column_name",
        "data_type",
        "is_nullable",
        "ordinal_position",
      ]) {
        assert.match(sql, new RegExp(`AS ${alias}`), `${provider} is missing ${alias}`);
      }
    }
  });
});

describe("Explore schema normalization", () => {
  test("groups columns by schema and table and sorts the finished tree", () => {
    const schema = buildExploreSchema("postgres", [
      row({
        schema_name: "sales",
        table_name: "orders",
        column_name: "total",
        ordinal_position: 2,
      }),
      row({
        schema_name: "public",
        table_name: "users",
        column_name: "email",
        ordinal_position: 2,
      }),
      row({ schema_name: "sales", table_name: "orders", column_name: "id", ordinal_position: 1 }),
      row({ schema_name: "public", table_name: "users", column_name: "id", ordinal_position: 1 }),
    ]);

    assert.deepEqual(
      schema.tables.map((table) => `${table.schema}.${table.name}`),
      ["public.users", "sales.orders"],
    );
    assert.deepEqual(
      schema.tables[0].columns.map((column) => column.name),
      ["id", "email"],
    );
    assert.deepEqual(
      schema.tables[1].columns.map((column) => column.name),
      ["id", "total"],
    );
  });

  test("classifies SQL and ClickHouse view kinds without leaking engine names", () => {
    const schema = buildExploreSchema("clickhouse", [
      row({ table_name: "events", table_kind: "MergeTree" }),
      row({ table_name: "daily_events", table_kind: "MaterializedView" }),
      row({ table_name: "active_events", table_kind: "VIEW" }),
    ]);
    assert.deepEqual(
      schema.tables.map((table) => [table.name, table.kind]),
      [
        ["active_events", "view"],
        ["daily_events", "view"],
        ["events", "table"],
      ],
    );
  });

  test("normalizes nullable flags from each driver's primitive shape", () => {
    const schema = buildExploreSchema("mysql", [
      row({ column_name: "yes_text", is_nullable: "YES", ordinal_position: 1 }),
      row({ column_name: "no_text", is_nullable: "NO", ordinal_position: 2 }),
      row({ column_name: "one_number", is_nullable: 1, ordinal_position: 3 }),
      row({ column_name: "one_text", is_nullable: "1", ordinal_position: 4 }),
      row({ column_name: "boolean", is_nullable: true, ordinal_position: 5 }),
    ]);
    assert.deepEqual(
      schema.tables[0].columns.map((column) => column.nullable),
      [true, false, true, true, true],
    );
  });

  test("uses safe defaults for missing types and invalid positions", () => {
    const schema = buildExploreSchema("postgres", [
      row({ column_name: "second", data_type: "", ordinal_position: "not-a-number" }),
      row({ column_name: "first", data_type: null, ordinal_position: 0 }),
    ]);
    assert.deepEqual(schema.tables[0].columns, [
      { name: "second", dataType: "unknown", nullable: false, position: 1 },
      { name: "first", dataType: "unknown", nullable: false, position: 2 },
    ]);
  });

  test("ignores malformed metadata rows instead of failing the whole browser", () => {
    const schema = buildExploreSchema("postgres", [
      {},
      { schema_name: "", table_name: "users", column_name: "id" },
      { table_name: "users", column_name: "id" },
      { column_name: "id" },
      { table_name: "users" },
      row({ schema_name: "public", table_name: "users", column_name: "id" }),
    ]);
    assert.equal(schema.tables.length, 1);
    assert.equal(schema.tables[0].columns.length, 1);
  });

  test("preserves the executor's truncation warning", () => {
    const schema = buildExploreSchema("postgres", [row()], true);
    assert.equal(schema.provider, "postgres");
    assert.equal(schema.truncated, true);
  });
});

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_name: "public",
    table_name: "example",
    table_kind: "BASE TABLE",
    column_name: "id",
    data_type: "integer",
    is_nullable: "NO",
    ordinal_position: 1,
    ...overrides,
  };
}
