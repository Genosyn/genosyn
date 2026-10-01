import assert from "node:assert/strict";
import { test } from "node:test";
import { describePostgresTable } from "./postgres.js";

type Table = { schema: string; name: string; columns: string[]; primaryKey: string[] };

/**
 * A catalog that answers the three queries `describe_table` issues the way
 * Postgres does: names are case-sensitive data, and nothing is parsed as an
 * identifier. The old primary-key lookup cast `'public.Project'` to
 * `regclass`, which folds it to `public.project` — this fake refuses any such
 * cast so a regression cannot pass.
 */
function catalog(tables: Table[]) {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string, params: unknown[] = []) {
      sql.push(text);
      assert.doesNotMatch(text, /regclass/, "names must never be parsed as SQL identifiers");
      const [schema, table] = params as [string, string];
      if (text.includes("information_schema.tables")) {
        const rows = tables
          .filter(
            (t) =>
              t.schema.toLowerCase() === schema.toLowerCase() &&
              t.name.toLowerCase() === table.toLowerCase(),
          )
          .map((t) => ({ table_schema: t.schema, table_name: t.name }));
        return { rows, rowCount: rows.length };
      }
      const found = tables.find((t) => t.schema === schema && t.name === table);
      if (text.includes("information_schema.columns")) {
        const rows = (found?.columns ?? []).map((column_name) => ({
          column_name,
          data_type: "text",
          is_nullable: "YES",
          column_default: null,
          character_maximum_length: null,
        }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("pg_index")) {
        assert.match(text, /n\.nspname = \$1 AND c\.relname = \$2/);
        const rows = (found?.primaryKey ?? []).map((column_name) => ({ column_name }));
        return { rows, rowCount: rows.length };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

const oneUptime: Table[] = [
  {
    schema: "public",
    name: "Project",
    columns: ["_id", "name", "deletedAt", "createdByUserId"],
    primaryKey: ["_id"],
  },
  {
    schema: "public",
    name: "ProjectUser",
    columns: ["projectId", "userId", "role"],
    primaryKey: ["projectId", "userId"],
  },
  { schema: "public", name: "user_sessions", columns: ["id"], primaryKey: ["id"] },
];

test("a mixed-case table is described with its primary key", async () => {
  const db = catalog(oneUptime);
  const described = await describePostgresTable(db, "public", "Project");
  assert.deepEqual(described, {
    schema: "public",
    table: "Project",
    columns: described.columns,
    primaryKey: ["_id"],
  });
  assert.deepEqual(
    (described.columns as Array<{ column_name: string }>).map((c) => c.column_name),
    ["_id", "name", "deletedAt", "createdByUserId"],
  );
  assert.deepEqual((await describePostgresTable(db, "public", "ProjectUser")).primaryKey, [
    "projectId",
    "userId",
  ]);
});

test("quoted and case-folded names resolve to the one real table", async () => {
  const db = catalog(oneUptime);
  for (const name of ['"Project"', "project", "PROJECT", ' "Project" ']) {
    const described = await describePostgresTable(db, " public ", name);
    assert.equal(described.table, "Project", name);
    assert.deepEqual(described.primaryKey, ["_id"], name);
  }
  assert.equal((await describePostgresTable(db, '"public"', "user_sessions")).table, "user_sessions");
});

test("a missing or ambiguous name says what to do next", async () => {
  await assert.rejects(
    describePostgresTable(catalog(oneUptime), "public", "DeletedProject"),
    /Table public\.DeletedProject not found or not visible to this role\. Call list_tables/,
  );
  const twins = catalog([
    { schema: "public", name: "Event", columns: ["id"], primaryKey: ["id"] },
    { schema: "public", name: "event", columns: ["id"], primaryKey: ["id"] },
  ]);
  await assert.rejects(
    describePostgresTable(twins, "public", "EVENT"),
    /matches several tables that differ only by case: public\."Event", public\."event"\. Pass the exact name\./,
  );
  assert.equal((await describePostgresTable(twins, "public", "event")).table, "event");
  await assert.rejects(describePostgresTable(twins, "public", '""'), /table is required/);
});
