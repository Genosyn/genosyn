import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  assignOperationIds,
  isPlural,
  OPERATION_ID_OVERRIDES,
  operationIdFor,
  operationNameFor,
  segmentWords,
  singularize,
  summaryFor,
  type OperationKey,
} from "./naming.js";
import type { HttpMethod } from "./routeDiscovery.js";

const idOf = (method: HttpMethod, path: string) => operationIdFor(operationNameFor(method, path));
const summaryOf = (method: HttpMethod, path: string) => summaryFor(operationNameFor(method, path));

describe("words", () => {
  test("segments split on separators and camel case, lower-cased", () => {
    assert.deepEqual(segmentWords("ai-access"), ["ai", "access"]);
    assert.deepEqual(segmentWords("feed.json"), ["feed", "json"]);
    assert.deepEqual(segmentWords("custom-javascript-loader.js"), [
      "custom",
      "javascript",
      "loader",
      "js",
    ]);
    assert.deepEqual(segmentWords("runConcurrency"), ["run", "concurrency"]);
    assert.deepEqual(segmentWords("snake_case"), ["snake", "case"]);
    assert.deepEqual(segmentWords(""), []);
  });

  test("singulars follow English, not just a trailing s", () => {
    for (const [plural, singular] of [
      ["deals", "deal"],
      ["activities", "activity"],
      ["policies", "policy"],
      ["entries", "entry"],
      ["matches", "match"],
      ["boxes", "box"],
      ["addresses", "address"],
      ["analyses", "analysis"],
      ["criteria", "criterion"],
      ["bases", "base"],
      ["keys", "key"],
      ["dms", "dm"],
    ]) {
      assert.equal(singularize(plural), singular, plural);
    }
  });

  test("words that only look plural stay put", () => {
    for (const word of [
      "access",
      "status",
      "settings",
      "metrics",
      "analysis",
      "sms",
      "js",
      "ics",
      "news",
      "usage",
      "progress",
    ]) {
      assert.equal(singularize(word), word, word);
      assert.equal(isPlural(word), false, word);
    }
    assert.equal(isPlural("deals"), true);
    assert.equal(isPlural("deal"), false);
  });
});

describe("operation names read as a verb and what it acts on", () => {
  const cases: Array<[HttpMethod, string, string, string]> = [
    ["get", "/api/companies/{cid}/revenue/deals", "listRevenueDeals", "List revenue deals"],
    ["post", "/api/companies/{cid}/revenue/deals", "createRevenueDeal", "Create revenue deal"],
    ["get", "/api/companies/{cid}/revenue/deals/{id}", "getRevenueDeal", "Get revenue deal"],
    [
      "patch",
      "/api/companies/{cid}/revenue/deals/{id}",
      "updateRevenueDeal",
      "Update revenue deal",
    ],
    [
      "delete",
      "/api/companies/{cid}/revenue/deals/{id}",
      "deleteRevenueDeal",
      "Delete revenue deal",
    ],
    [
      "post",
      "/api/companies/{cid}/revenue/deals/{id}/archive",
      "archiveRevenueDeal",
      "Archive revenue deal",
    ],
    [
      "get",
      "/api/companies/{cid}/revenue/deals/board",
      "getRevenueDealsBoard",
      "Get revenue deals board",
    ],
    [
      "put",
      "/api/companies/{cid}/revenue/ai-access/{employeeId}",
      "setRevenueAiAccess",
      "Set revenue AI access",
    ],
    [
      "get",
      "/api/companies/{cid}/revenue/activities/export",
      "exportRevenueActivities",
      "Export revenue activities",
    ],
    [
      "post",
      "/api/companies/{cid}/revenue/stages/reorder",
      "reorderRevenueStages",
      "Reorder revenue stages",
    ],
    [
      "get",
      "/api/companies/{cid}/employees/{eid}/routines",
      "listEmployeeRoutines",
      "List employee routines",
    ],
    ["get", "/api/companies/{cid}/routines", "listRoutines", "List routines"],
    ["get", "/api/companies/{cid}", "getCompany", "Get company"],
    ["patch", "/api/companies/{cid}", "updateCompany", "Update company"],
    ["get", "/api/companies", "listCompanies", "List companies"],
    [
      "get",
      "/api/companies/{cid}/decision-stack/settings",
      "getDecisionStackSettings",
      "Get decision stack settings",
    ],
    ["put", "/api/backups/schedule", "setBackupsSchedule", "Set backups schedule"],
    [
      "post",
      "/api/companies/{cid}/phone/calls/{callId}/hang-up",
      "hangUpPhoneCall",
      "Hang up phone call",
    ],
    ["post", "/api/companies/{cid}/approvals/bulk", "bulkApprovals", "Bulk approvals"],
    [
      "post",
      "/api/companies/{cid}/bases/{baseSlug}/tables/{tableId}/rows/bulk-delete",
      "bulkDeleteBaseTableRows",
      "Bulk delete base table rows",
    ],
    [
      "post",
      "/api/companies/{cid}/repositories/{slug}/sessions/{sessionId}/pull-request",
      "createRepositorySessionPullRequest",
      "Create repository session pull request",
    ],
    [
      "get",
      "/api/companies/{cid}/revenue/follow-ups",
      "listRevenueFollowUps",
      "List revenue follow ups",
    ],
    ["post", "/api/companies/{cid}/workspace/dms", "createWorkspaceDm", "Create workspace dm"],
    [
      "delete",
      "/api/companies/{cid}/employees/{eid}/mcp/connect",
      "deleteEmployeeMcpConnect",
      "Delete employee MCP connect",
    ],
    [
      "post",
      "/api/companies/{cid}/employees/{eid}/mcp/connect",
      "connectEmployeeMcp",
      "Connect employee MCP",
    ],
    ["get", "/api/health", "getHealth", "Get health"],
    ["post", "/api/companies/{cid}/deals/{id}", "submitDeal", "Submit deal"],
  ];
  for (const [method, path, id, summary] of cases) {
    test(`${method.toUpperCase()} ${path}`, () => {
      assert.equal(idOf(method, path), id);
      assert.equal(summaryOf(method, path), summary);
    });
  }

  test("a PUT, PATCH or DELETE never reads its last segment as an action", () => {
    assert.equal(idOf("put", "/api/admin/signup-settings"), "setAdminSignupSettings");
    assert.equal(
      idOf("patch", "/api/companies/{cid}/proactive/defaults"),
      "updateProactiveDefaults",
    );
    assert.equal(idOf("delete", "/api/companies/{cid}/x/archive"), "deleteXArchive");
  });

  test("ids are identifiers every consumer accepts", () => {
    for (const [method, path] of cases) {
      assert.match(idOf(method, path), /^[a-z][A-Za-z0-9]*$/);
    }
  });
});

describe("assigning ids", () => {
  const ops: OperationKey[] = [
    { method: "get", path: "/api/companies/{cid}/deals" },
    { method: "get", path: "/api/companies/{cid}/deals/{id}" },
    { method: "post", path: "/api/companies/{cid}/deals" },
    // Same literals, parameters in a different place: the base ids collide.
    { method: "get", path: "/api/companies/{cid}/deals/{dealId}/notes" },
    { method: "get", path: "/api/companies/{cid}/deal/notes" },
  ];

  test("every operation gets a unique id", () => {
    const ids = assignOperationIds(ops);
    assert.equal(ids.size, ops.length);
    assert.equal(new Set(ids.values()).size, ops.length);
  });

  test("the result depends on the set of operations, never their order", () => {
    const forward = assignOperationIds(ops);
    for (let shuffle = 0; shuffle < 10; shuffle++) {
      const shuffled = [...ops].sort(() => Math.random() - 0.5);
      assert.deepEqual(
        [...assignOperationIds(shuffled).entries()].sort(),
        [...forward.entries()].sort(),
      );
    }
  });

  test("on a collision the shorter path keeps the plain id and the other names its parameters", () => {
    const ids = assignOperationIds(ops);
    assert.equal(ids.get("GET /api/companies/{cid}/deal/notes"), "listDealNotes");
    assert.equal(ids.get("GET /api/companies/{cid}/deals/{dealId}/notes"), "listDealNotesByDealId");
  });

  test("reserved ids are kept and never handed out again", () => {
    const reserved = new Map([["GET /api/companies/{cid}/deals", "listDeals"]]);
    const ids = assignOperationIds(
      [...ops, { method: "get", path: "/api/companies/{cid}/x/deals" }],
      reserved,
    );
    assert.equal(ids.get("GET /api/companies/{cid}/deals"), "listDeals");
    assert.equal(new Set(ids.values()).size, ids.size);

    const clash = assignOperationIds(
      [{ method: "get", path: "/api/companies/{cid}/deals" }],
      new Map([["GET /api/other", "listDeals"]]),
    );
    assert.equal(clash.get("GET /api/companies/{cid}/deals"), "listDealsByGet");
  });

  test("the override table names real-looking routes with identifier-safe ids", () => {
    const ids = Object.values(OPERATION_ID_OVERRIDES);
    assert.equal(new Set(ids).size, ids.length, "override ids are unique");
    for (const [key, id] of Object.entries(OPERATION_ID_OVERRIDES)) {
      assert.match(key, /^(GET|POST|PUT|PATCH|DELETE) \/api\//, key);
      assert.match(id, /^[a-z][A-Za-z0-9]*$/, id);
    }
  });
});
