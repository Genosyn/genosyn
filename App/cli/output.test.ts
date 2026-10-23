import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CliError } from "./errors.js";
import {
  cellText,
  chooseColumns,
  colorEnabled,
  isKeepColumn,
  listProperty,
  paint,
  renderRecord,
  renderTable,
  renderValue,
  selectPath,
  truncate,
  type RenderOptions,
} from "./output.js";

const human: RenderOptions = { json: false, pretty: true, color: false, width: 100 };
const program: RenderOptions = { json: true, pretty: false, color: false, width: 100 };

describe("selectPath", () => {
  const value = {
    id: "d1",
    rows: [
      { id: "a", owner: { name: "Ada" } },
      { id: "b", owner: { name: "Grace" } },
    ],
    total: 2,
  };

  test("walks keys and array indexes", () => {
    assert.equal(selectPath(value, "id"), "d1");
    assert.equal(selectPath(value, "rows.1.owner.name"), "Grace");
    assert.equal(selectPath(value, "rows[0].id"), "a");
    assert.equal(selectPath(value, "rows.-1.id"), "b");
  });

  test("fans out over every element with *", () => {
    assert.deepEqual(selectPath(value, "rows.*.id"), ["a", "b"]);
    assert.deepEqual(selectPath(value, "rows[*].owner.name"), ["Ada", "Grace"]);
    assert.deepEqual(selectPath({ a: { x: 1 }, b: { x: 2 } }, "*.x"), [1, 2]);
  });

  test("yields null for a missing step, as jq does", () => {
    assert.equal(selectPath(value, "nope"), null);
    assert.equal(selectPath(value, "rows.9.id"), null);
    assert.equal(selectPath("scalar", "a"), null);
  });

  test("needs a path", () => {
    assert.throws(() => selectPath(value, " . "), (error: unknown) => error instanceof CliError && error.kind === "usage");
  });
});

describe("renderValue for programs", () => {
  test("prints compact JSON, one document per run", () => {
    assert.equal(renderValue({ a: [1, 2] }, program), '{"a":[1,2]}\n');
    assert.equal(renderValue([], program), "[]\n");
    assert.equal(renderValue(null, program), "null\n");
    assert.equal(renderValue("text", program), '"text"\n');
  });

  test("indents JSON for a person at a terminal", () => {
    assert.equal(renderValue({ a: 1 }, { ...program, pretty: true }), '{\n  "a": 1\n}\n');
  });

  test("prints nothing for no result", () => {
    assert.equal(renderValue(undefined, program), "");
    assert.equal(renderValue(undefined, human), "");
  });

  test("prints strings and numbers bare when asked, ready for $(…)", () => {
    assert.equal(renderValue("d1", { ...program, bareScalars: true }), "d1\n");
    assert.equal(renderValue(42, { ...program, bareScalars: true }), "42\n");
    assert.equal(renderValue({ a: 1 }, { ...program, bareScalars: true }), '{"a":1}\n');
  });
});

describe("renderValue for people", () => {
  test("prints a list of records as a table, familiar columns first", () => {
    const text = renderValue(
      [
        { createdAt: "2026-01-01", title: "First", id: "a1", nested: { x: 1 } },
        { createdAt: "2026-01-02", title: "Second", id: "a2", nested: { x: 2 } },
      ],
      human,
    );
    const [header, first, second] = text.trimEnd().split("\n");
    assert.match(header, /^ID\s+TITLE\s+CREATEDAT$/);
    assert.match(first, /^a1\s+First\s+2026-01-01$/);
    assert.match(second, /^a2\s+Second\s+2026-01-02$/);
    assert.ok(!text.includes("NESTED"), "objects stay out of tables");
  });

  test("prints a page's rows as a table with its totals beneath", () => {
    const text = renderValue({ rows: [{ id: "a", title: "A" }], total: 1, nextCursor: null }, human);
    assert.match(text, /^ID\s+TITLE\na\s+A\n\ntotal\s+1\nnextCursor\s+\n$/);
  });

  test("prints a record as aligned key-value lines", () => {
    const text = renderValue({ id: "g1", title: "Grow", tags: ["a", "b"], owner: { name: "Ada" } }, human);
    assert.equal(text, 'id     g1\ntitle  Grow\ntags   a, b\nowner  {"name":"Ada"}\n');
  });

  test("keeps a record with a nested object or an empty list a record", () => {
    assert.match(renderValue({ id: "d1", contacts: [{ id: "c1" }], customer: { id: "x" } }, human), /^id\s+d1\n/);
    assert.equal(renderValue({ id: "d1", tags: [] }, human), "id    d1\ntags  \n");
  });

  test("says when a list is empty", () => {
    assert.equal(renderValue([], human), "(no results)\n");
    assert.match(renderValue({ rows: [], total: 0 }, human), /^\(no results\)\n\ntotal\s+0\n$/);
  });

  test("prints scalars and lists of scalars plainly", () => {
    assert.equal(renderValue("hello", human), "hello\n");
    assert.equal(renderValue(["a", "b"], human), "a\nb\n");
    assert.equal(renderValue(true, human), "true\n");
    assert.equal(renderValue(null, human), "null\n");
  });

  test("shows a long text field in full up to a point", () => {
    const text = renderValue({ body: "x".repeat(600) }, human);
    assert.match(text, /\(100 more characters; --json shows all\)/);
  });

  test("honours chosen columns", () => {
    const text = renderValue([{ id: "a", title: "A", status: "open" }], { ...human, columns: ["status", "id"] });
    assert.match(text.split("\n")[0], /^STATUS\s+ID$/);
  });
});

describe("table pieces", () => {
  test("cellText keeps one line and cuts long text", () => {
    assert.equal(cellText("a\n  b", 10), "a b");
    assert.equal(cellText(null, 10), "");
    assert.equal(cellText({ a: 1 }, 20), '{"a":1}');
    assert.equal(cellText("abcdefghij", 5), "abcd…");
    assert.equal(truncate("abc", 1), "a");
  });

  test("never cuts an id or a command; the widest other column gives way", () => {
    const id = "3f2c7a10-1111-4222-8333-444455556666";
    const text = renderTable(
      [{ id, command: "revenue list-revenue-deals-by-stage", summary: "s".repeat(80) }],
      ["id", "command", "summary"],
      { color: false, width: 90 },
    );
    const row = text.split("\n")[1];
    assert.ok(row.startsWith(`${id}  revenue list-revenue-deals-by-stage  `), row);
    assert.ok(row.endsWith("…"));
    assert.ok(row.length <= 90, `${row.length} columns`);
    assert.ok(isKeepColumn("customerId") && isKeepColumn("slug") && !isKeepColumn("title"));
  });

  test("leaves out columns that are empty in every row", () => {
    assert.deepEqual(
      chooseColumns(
        [
          { id: "a", title: "A", description: "", closedAt: null, tags: [] },
          { id: "b", title: "B", description: null, closedAt: null, tags: [] },
        ],
        100,
      ),
      ["id", "title"],
    );
  });

  test("chooseColumns fits the width and always keeps one", () => {
    const rows = [{ id: "1", name: "n".repeat(30), description: "d".repeat(30), other: "o".repeat(30) }];
    assert.deepEqual(chooseColumns(rows, 50), ["id", "name"]);
    assert.deepEqual(chooseColumns([{ huge: "h".repeat(200) }], 10), ["huge"]);
    assert.deepEqual(chooseColumns(rows, 50, ["other"]), ["other"]);
  });

  test("renderTable pads columns and bolds the header in color", () => {
    const text = renderTable([{ id: "1", name: "Ada" }], ["id", "name"], { color: true, width: 80 });
    assert.ok(text.startsWith("\u001b[1mID  NAME\u001b[0m\n"));
    assert.ok(text.endsWith("1   Ada\n"));
  });

  test("renderRecord handles an empty record", () => {
    assert.equal(renderRecord({}, { color: false, width: 80 }), "{}\n");
  });

  test("listProperty finds the one list of records", () => {
    assert.equal(listProperty({ rows: [{ a: 1 }], total: 1 }), "rows");
    assert.equal(listProperty({ items: [], nextCursor: null }), "items");
    assert.equal(listProperty({ columns: [] }), "columns");
    assert.equal(listProperty({ a: [{ x: 1 }], b: [{ y: 2 }] }), null);
    assert.equal(listProperty({ tags: ["a"], id: "x" }), null);
    assert.equal(listProperty({ tags: [], id: "x" }), null);
    assert.equal(listProperty({ rows: [{ a: 1 }], owner: { id: "u" } }), null);
  });
});

describe("color", () => {
  test("only on a terminal, never with NO_COLOR, --no-color or a dumb terminal", () => {
    assert.equal(colorEnabled({ isTTY: true }, {}, false), true);
    assert.equal(colorEnabled({ isTTY: false }, {}, false), false);
    assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }, false), false);
    assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "" }, false), true);
    assert.equal(colorEnabled({ isTTY: true }, {}, true), false);
    assert.equal(colorEnabled({ isTTY: true }, { TERM: "dumb" }, false), false);
  });

  test("paint wraps only when enabled", () => {
    assert.equal(paint("red", "x", false), "x");
    assert.equal(paint("red", "x", true), "\u001b[31mx\u001b[0m");
  });
});
