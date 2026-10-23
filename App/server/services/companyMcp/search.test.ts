import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createApp } from "../../app.js";
import {
  buildOperationCatalogue,
  operationCatalogue,
  type OpenApiDocumentLike,
} from "./catalogue.js";
import {
  areaOverview,
  resolveArea,
  searchOperations,
  searchWords,
  similarOperationNames,
} from "./search.js";

/**
 * Finding an operation by what an agent wants to do. The real catalogue
 * checks that everyday requests land on the right operation first; a small
 * synthetic one pins the ranking rules exactly.
 */

const catalogue = operationCatalogue(createApp());

function first(query: string, options: { area?: string } = {}) {
  return searchOperations(catalogue, { query, limit: 5, offset: 0, ...options }).operations[0];
}

describe("words", () => {
  test("are folded the way operation ids were built", () => {
    assert.deepEqual(searchWords("createRevenueDeal"), ["create", "revenue", "deal"]);
    assert.deepEqual(searchWords("List the overdue Invoices!"), ["list", "overdue", "invoice"]);
    assert.deepEqual(searchWords("getAIModels"), ["get", "ai", "model"]);
    assert.deepEqual(searchWords("follow-ups, activities & people"), [
      "follow",
      "up",
      "activity",
      "person",
    ]);
    assert.deepEqual(searchWords("   "), []);
    assert.deepEqual(searchWords("a the of"), [], "stopwords say nothing");
  });
});

describe("everyday requests land on the right operation first", () => {
  const cases: Array<[string, string]> = [
    ["create a deal", "createRevenueDeal"],
    ["add a contact", "createRevenueContact"],
    ["new revenue contact", "createRevenueContact"],
    ["list overdue invoices", "listInvoices"],
    ["run a routine now", "runRoutine"],
    ["who am i", "getCompanyMe"],
    ["delete tag", "deleteTag"],
    ["rename a tag", "updateTag"],
    ["upload a contract", "createContract"],
    ["download invoice pdf", "getInvoicePdf"],
    ["list goals", "listGoals"],
    ["decisions", "listDecisions"],
  ];
  for (const [query, expected] of cases) {
    test(`"${query}" → ${expected}`, () => {
      const found = searchOperations(catalogue, { query, limit: 3, offset: 0 }).operations.map(
        (operation) => operation.name,
      );
      assert.equal(found[0], expected, `got ${found.join(", ")}`);
    });
  }

  test("people's words reach the product's: tasks, agents and leads", () => {
    assert.equal(first("tasks")?.area, "Tasks");
    assert.equal(first("list my agents")?.area, "Employees");
    assert.equal(first("leads")?.area, "Revenue");
    assert.match(first("leads")?.name ?? "", /Contact/);
    assert.equal(first("email drafts")?.area, "Email");
  });
});

describe("filters and pages", () => {
  test("an area keeps results inside it; a kind keeps one kind", () => {
    const inTags = searchOperations(catalogue, {
      query: "list",
      area: "Tags",
      limit: 50,
      offset: 0,
    });
    assert.ok(inTags.total > 0);
    assert.ok(inTags.operations.every((operation) => operation.area === "Tags"));
    const deletes = searchOperations(catalogue, {
      query: "deal",
      kind: "delete",
      limit: 50,
      offset: 0,
    });
    assert.ok(deletes.total > 0);
    assert.ok(deletes.operations.every((operation) => operation.method === "delete"));
  });

  test("with no query, an area is listed whole in path order", () => {
    const all = searchOperations(catalogue, { area: "Tags", limit: 100, offset: 0 });
    const inArea = catalogue.operations.filter((operation) => operation.area === "Tags");
    assert.equal(all.total, inArea.length);
    const paths = all.operations.map((operation) => operation.path);
    assert.deepEqual(paths, [...paths].sort());
  });

  test("offset and limit slice the same ranking", () => {
    const whole = searchOperations(catalogue, { query: "revenue", limit: 20, offset: 0 });
    const page = searchOperations(catalogue, { query: "revenue", limit: 5, offset: 5 });
    assert.equal(page.total, whole.total);
    assert.deepEqual(
      page.operations.map((operation) => operation.name),
      whole.operations.slice(5, 10).map((operation) => operation.name),
    );
    const past = searchOperations(catalogue, { query: "revenue", limit: 5, offset: whole.total });
    assert.deepEqual(past.operations, []);
  });

  test("a query nothing matches finds nothing", () => {
    assert.equal(searchOperations(catalogue, { query: "zzzqqq", limit: 5, offset: 0 }).total, 0);
  });
});

describe("areas", () => {
  test("are found by name in any case or spelled as a slug", () => {
    assert.equal(resolveArea(catalogue, "revenue"), "Revenue");
    assert.equal(resolveArea(catalogue, "REVENUE"), "Revenue");
    assert.equal(resolveArea(catalogue, "letters-to-the-board"), "Letters to the board");
    assert.equal(resolveArea(catalogue, "  Document signing "), "Document signing");
    assert.equal(resolveArea(catalogue, "Spaceships"), null);
    assert.equal(resolveArea(catalogue, "---"), null);
  });

  test("the overview counts every operation once, by kind", () => {
    const overview = areaOverview(catalogue);
    assert.deepEqual(
      overview.map((area) => area.name),
      catalogue.areas.map((area) => area.name),
    );
    assert.equal(
      overview.reduce((sum, area) => sum + area.operations, 0),
      catalogue.operations.length,
    );
    for (const area of overview) {
      assert.equal(area.read + area.write + area.delete, area.operations, area.name);
    }
  });
});

describe("near misses", () => {
  test("a mistyped id suggests the one meant", () => {
    assert.equal(similarOperationNames(catalogue, "createTags")[0], "createTag");
    assert.equal(similarOperationNames(catalogue, "listInvoice")[0], "listInvoices");
    assert.ok(similarOperationNames(catalogue, "getRevenueDeals").includes("getRevenueDeal"));
    assert.ok(similarOperationNames(catalogue, "x").length <= 3);
  });
});

describe("the ranking rules", () => {
  const op = (operationId: string, method: string, path: string, summary: string, tag: string) => ({
    [method]: {
      operationId,
      summary,
      tags: [tag],
      "x-genosyn-access": { apiKey: true, browserSession: true },
      responses: { 200: { description: "OK", content: { "application/json": { schema: {} } } } },
    },
  });
  const small = buildOperationCatalogue({
    paths: {
      "/api/companies/{cid}/widgets": {
        ...op("listWidgets", "get", "/widgets", "List widgets", "Widgets"),
        ...op("createWidget", "post", "/widgets", "Create a widget", "Widgets"),
      },
      "/api/companies/{cid}/widgets/{id}": {
        ...op("getWidget", "get", "/widgets/{id}", "Get a widget", "Widgets"),
        ...op("deleteWidget", "delete", "/widgets/{id}", "Delete a widget", "Widgets"),
      },
      "/api/companies/{cid}/gadgets": {
        ...op(
          "listGadgets",
          "get",
          "/gadgets",
          "List gadgets, often with widgets attached",
          "Gadgets",
        ),
      },
    },
    tags: [{ name: "Widgets" }, { name: "Gadgets" }],
  } as OpenApiDocumentLike);

  const names = (query: string) =>
    searchOperations(small, { query, limit: 10, offset: 0 }).operations.map(
      (operation) => operation.name,
    );

  test("more of the query's words matched beats a higher score on fewer", () => {
    assert.equal(names("delete widget")[0], "deleteWidget");
    assert.equal(names("create widget")[0], "createWidget");
  });

  test("on a tie, reads come before writes and deletes, then shorter paths", () => {
    assert.deepEqual(names("widget"), [
      "listWidgets",
      "getWidget",
      "createWidget",
      "deleteWidget",
      "listGadgets",
    ]);
  });

  test("a word only in the prose ranks below one in the name", () => {
    const ranked = names("widgets");
    assert.equal(ranked[ranked.length - 1], "listGadgets");
  });

  test("a synonym finds what the word itself does not", () => {
    assert.equal(names("remove widget")[0], "deleteWidget");
    assert.equal(names("show widgets")[0], "listWidgets");
  });

  test("a prefix of three letters or more matches", () => {
    assert.ok(names("gadg").includes("listGadgets"));
    assert.deepEqual(names("ga"), [], "two letters are too few to guess from");
  });
});
