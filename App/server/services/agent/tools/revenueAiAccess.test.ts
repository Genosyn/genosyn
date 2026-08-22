import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import {
  hasSafeDirectWriteProvenance,
  mcpInternalRouter,
  proposeStripeCommercialValuesToolSchema,
} from "../../../routes/mcpInternal.js";
import { TOOL_DOMAINS, TOOL_KEYWORDS } from "./toolIndex.js";

const NEW_REVENUE_AI_TOOLS = [
  "preview_revenue_rows_import",
  "run_revenue_rows_import",
  "preview_linked_revenue_rows_import",
  "run_linked_revenue_rows_import",
  "list_deal_history_coverage",
  "preview_deal_history_backfill",
  "backfill_deal_history",
  "list_commercial_value_backlog",
  "propose_finance_commercial_values",
  "propose_stripe_commercial_values",
  "export_revenue_snapshot",
] as const;

function contract(name: string): string {
  const tool = STATIC_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing Revenue AI tool ${name}`);
  return JSON.stringify(tool);
}

function includesContract(name: string, fragments: string[]): void {
  const serialized = contract(name);
  for (const fragment of fragments) {
    assert.ok(serialized.includes(fragment), `${name} contract is missing ${fragment}`);
  }
}

function requiredProperties(name: string): string[] {
  const tool = STATIC_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing Revenue AI tool ${name}`);
  return (tool.inputSchema as { required?: string[] }).required ?? [];
}

describe("Revenue AI capability contracts", () => {
  test("every new Revenue manifest tool resolves to a POST handler", () => {
    const stack = (
      mcpInternalRouter as unknown as {
        stack?: Array<{
          route?: {
            path?: unknown;
            methods?: Record<string, boolean>;
            stack?: unknown[];
          };
        }>;
      }
    ).stack;
    assert.ok(stack, "the internal MCP router exposes no route stack");

    for (const name of NEW_REVENUE_AI_TOOLS) {
      const route:
        | {
            path?: unknown;
            methods?: Record<string, boolean>;
            stack?: unknown[];
          }
        | undefined = stack
        .map((layer) => layer.route)
        .find((candidate) => candidate?.path === `/tools/${name}`);
      assert.ok(route, `missing internal MCP handler for ${name}`);
      assert.equal(route.methods?.post, true, `${name} is not wired as a POST handler`);
      assert.ok((route.stack?.length ?? 0) > 0, `${name} has no handler middleware`);
    }
  });

  test("row-based imports expose CSV, JSON, and granted Connection provenance safely", () => {
    for (const name of [
      "preview_revenue_rows_import",
      "run_revenue_rows_import",
      "preview_linked_revenue_rows_import",
      "run_linked_revenue_rows_import",
    ]) {
      includesContract(name, [
        "csv",
        "json",
        "connection",
        "sourceConnectionId",
        "sourceLabel",
        "rows",
        "sourceId",
        "values",
      ]);
    }
    for (const name of ["run_revenue_rows_import", "run_linked_revenue_rows_import"]) {
      includesContract(name, ["confirm", "IMPORT"]);
      assert.ok(requiredProperties(name).includes("confirm"));
    }
    includesContract("preview_revenue_rows_import", [
      "account",
      "contact",
      "deal",
      "partnership",
      "mapping",
    ]);
    includesContract("preview_linked_revenue_rows_import", [
      "account",
      "contact",
      "deal",
      "mapping",
    ]);
  });

  test("historical Deal import and reporting expose every dated event concept", () => {
    includesContract("preview_historical_deal_import", [
      "originalCreatedAt",
      "historyCompleteness",
      "sourceEventId",
      "effectiveAt",
      "stage_changed",
      "amount_changed",
      "owner_changed",
      "won",
      "lost",
      "lostReason",
    ]);
    includesContract("run_historical_deal_import", ["batchKey", "sourceSystem", "IMPORT"]);
    includesContract("list_deal_history", ["sourceKind", "kind", "from", "to"]);
    includesContract("list_deal_history_coverage", [
      "dealIds",
      "includeArchived",
      "limit",
      "offset",
    ]);
    includesContract("preview_deal_history_backfill", ["dealIds"]);
    includesContract("backfill_deal_history", [
      "dealIds",
      "minItems",
      "idempotencyKey",
      "confirm",
      "BACKFILL",
    ]);
    assert.deepEqual(requiredProperties("backfill_deal_history"), [
      "dealIds",
      "idempotencyKey",
      "confirm",
    ]);
  });

  test("generic merge, redirect, audit, and guarded undo cover every core record", () => {
    for (const name of ["preview_revenue_record_merge", "merge_revenue_records"]) {
      includesContract(name, ["account", "contact", "deal", "partnership"]);
    }
    includesContract("resolve_revenue_record_redirect", ["resourceType", "sourceId"]);
    includesContract("list_revenue_operations", ["merge", "bulk", "history_import"]);
    includesContract("get_revenue_operation", ["rowLimit", "rowOffset"]);
    includesContract("undo_revenue_operation", ["operationId", "UNDO"]);
  });

  test("asynchronous bulk jobs expose preview, modes, progress, reconciliation, and undo", () => {
    for (const name of ["preview_revenue_bulk_operation", "start_revenue_bulk_job"]) {
      includesContract(name, [
        "account",
        "contact",
        "deal",
        "partnership",
        "follow_up",
        "atomic",
        "partial",
        "archive",
        "move_deal_stage",
        "lostReason",
        "update_standard_fields",
        "UPDATE_STANDARD_FIELDS",
        "notesMode",
        "rows",
        "update_follow_up",
      ]);
    }
    includesContract("start_revenue_bulk_job", ["idempotencyKey"]);
    includesContract("get_revenue_bulk_job", ["rowLimit", "rowOffset"]);
    includesContract("export_revenue_bulk_reconciliation", ["limit", "offset"]);
    assert.ok(TOOL_KEYWORDS.undo_revenue_operation.includes("undo bulk job"));
  });

  test("Follow-up triage exposes rich filters, shared views, and bulk actions", () => {
    includesContract("list_follow_ups", [
      "assignedUserId",
      "assignedEmployeeId",
      "unassigned",
      "priority",
      "status",
      "linkedResourceType",
      "dueFrom",
      "reminderFrom",
      "overdueMinDays",
      "dealStageId",
      "dealStatus",
      "accountStatus",
      "closedDeals",
      "archivedResources",
      "cursor",
      "q",
    ]);
    for (const name of [
      "list_follow_up_views",
      "create_follow_up_view",
      "update_follow_up_view",
      "delete_follow_up_view",
    ]) {
      contract(name);
    }
    includesContract("preview_revenue_bulk_operation", ["followUpIds", "taskStatus", "dueAt"]);
  });

  test("import history stays compact while rows and reconciliation remain pageable", () => {
    includesContract("list_revenue_imports", ["limit", "offset", "resourceType"]);
    includesContract("get_revenue_import", ["importId"]);
    for (const name of ["list_revenue_import_rows", "export_revenue_import_reconciliation"]) {
      includesContract(name, [
        "resourceType",
        "status",
        "action",
        "sourceId",
        "nativeId",
        "error",
        "hasError",
        "limit",
        "offset",
      ]);
    }
    includesContract("rollback_revenue_import", ["importId", "confirm", "ROLLBACK"]);
    assert.deepEqual(requiredProperties("rollback_revenue_import"), ["importId", "confirm"]);
  });

  test("the native snapshot contract covers every requested Revenue export", () => {
    includesContract("export_revenue_snapshot", [
      "accounts",
      "contacts",
      "deals",
      "partnerships",
      "partnership_contacts",
      "buying_committees",
      "follow_ups",
      "documents",
      "stage_definitions",
      "custom_fields",
      "custom_values",
      "import_reconciliation",
      "deal_history",
      "field_evidence",
      "duplicate_candidates",
      "operation_audit",
      "document_candidates",
      "json",
      "csv",
      "dealId",
      "sourceKind",
      "kind",
      "from",
      "to",
      "resourceType",
      "resourceId",
      "fieldKey",
      "sourceType",
      "status",
      "minScore",
      "accountId",
    ]);
    const snapshot = STATIC_TOOLS.find((candidate) => candidate.name === "export_revenue_snapshot");
    assert.ok(snapshot);
    const resource = (
      snapshot.inputSchema as {
        properties?: { resource?: { enum?: string[] } };
      }
    ).properties?.resource;
    assert.equal(resource?.enum?.includes("document_candidates"), true);
    const accountId = (
      snapshot.inputSchema as {
        properties?: { accountId?: { description?: string } };
      }
    ).properties?.accountId;
    assert.match(accountId?.description ?? "", /required.*exact Mail Account/i);
  });

  test("domain, commercial value, duplicate, Gmail, and provenance workflows are reachable", () => {
    includesContract("propose_revenue_account_domains", [
      "accountIds",
      "verifiedContactIds",
      "followWebsiteRedirects",
    ]);
    includesContract("list_commercial_value_backlog", ["dealIds", "stageIds", "limit", "offset"]);
    includesContract("propose_finance_commercial_values", [
      "dealIds",
      "minItems",
      "confirm",
      "PROPOSE",
    ]);
    assert.deepEqual(requiredProperties("propose_finance_commercial_values"), [
      "dealIds",
      "confirm",
    ]);
    for (const name of [
      "propose_finance_commercial_values",
      "propose_stripe_commercial_values",
      "create_commercial_value_proposal",
      "list_revenue_field_evidence",
      "review_revenue_field_evidence",
    ]) {
      contract(name);
    }
    const stripe = STATIC_TOOLS.find(
      (candidate) => candidate.name === "propose_stripe_commercial_values",
    );
    assert.ok(stripe);
    const stripeSchema = stripe.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.ok(stripeSchema.properties?.connectionId);
    assert.ok(stripeSchema.properties?.dealIds);
    assert.deepEqual(stripeSchema.required, ["connectionId", "dealIds", "confirm"]);
    assert.equal(
      proposeStripeCommercialValuesToolSchema.safeParse({
        connectionId: "11111111-1111-4111-8111-111111111111",
        confirm: "PROPOSE",
      }).success,
      false,
    );
    assert.equal(
      proposeStripeCommercialValuesToolSchema.safeParse({
        connectionId: "11111111-1111-4111-8111-111111111111",
        dealIds: ["11111111-1111-4111-8111-111111111112"],
        confirm: "PROPOSE",
      }).success,
      true,
    );
    for (const name of [
      "scan_revenue_duplicates",
      "list_revenue_duplicate_candidates",
      "dismiss_revenue_duplicate_candidate",
      "preview_revenue_record_merge",
      "merge_revenue_records",
    ]) {
      contract(name);
    }
    for (const name of [
      "scan_revenue_mail_documents",
      "list_revenue_document_candidates",
      "review_revenue_document_candidate",
    ]) {
      contract(name);
    }
    includesContract("set_revenue_custom_fields", [
      "provenance",
      "sourceType",
      "sourceId",
      "extractionMethod",
      "confidence",
      "observedAt",
      "verificationState",
      "lastVerifiedAt",
    ]);
    const customFields = STATIC_TOOLS.find(
      (candidate) => candidate.name === "set_revenue_custom_fields",
    );
    assert.ok(customFields);
    const customSchema = customFields.inputSchema as {
      properties?: {
        provenance?: { required?: string[] };
      };
    };
    assert.ok(customSchema.properties?.provenance?.required?.includes("verificationState"));
    assert.equal(hasSafeDirectWriteProvenance(undefined), true);
    assert.equal(hasSafeDirectWriteProvenance({ verificationState: "verified" }), true);
    assert.equal(hasSafeDirectWriteProvenance({ verificationState: "unverified" }), false);
    includesContract("review_revenue_document_candidate", ["email_attachment"]);
    assert.ok(TOOL_KEYWORDS.merge_revenue_records.includes("merge duplicate candidate"));
    assert.ok(TOOL_KEYWORDS.set_revenue_custom_fields.includes("custom field provenance"));
  });

  test("every capability remains in the discoverable Revenue domain", () => {
    const revenue = new Set(TOOL_DOMAINS.revenue.tools);
    const expected = [
      "preview_revenue_rows_import",
      "run_revenue_rows_import",
      "preview_linked_revenue_rows_import",
      "run_linked_revenue_rows_import",
      "preview_historical_deal_import",
      "run_historical_deal_import",
      "list_deal_history",
      "list_deal_history_coverage",
      "preview_deal_history_backfill",
      "backfill_deal_history",
      "preview_revenue_record_merge",
      "merge_revenue_records",
      "resolve_revenue_record_redirect",
      "list_revenue_operations",
      "get_revenue_operation",
      "undo_revenue_operation",
      "preview_revenue_bulk_operation",
      "start_revenue_bulk_job",
      "get_revenue_bulk_job",
      "export_revenue_bulk_reconciliation",
      "list_follow_ups",
      "list_follow_up_views",
      "list_revenue_imports",
      "get_revenue_import",
      "list_revenue_import_rows",
      "export_revenue_import_reconciliation",
      "export_revenue_snapshot",
      "propose_revenue_account_domains",
      "list_commercial_value_backlog",
      "propose_finance_commercial_values",
      "propose_stripe_commercial_values",
      "create_commercial_value_proposal",
      "list_revenue_field_evidence",
      "review_revenue_field_evidence",
      "scan_revenue_duplicates",
      "list_revenue_duplicate_candidates",
      "dismiss_revenue_duplicate_candidate",
      "scan_revenue_mail_documents",
      "list_revenue_document_candidates",
      "review_revenue_document_candidate",
      "set_revenue_custom_fields",
    ];
    assert.deepEqual(
      expected.filter((name) => !revenue.has(name)),
      [],
    );
    assert.deepEqual(
      NEW_REVENUE_AI_TOOLS.filter((name) => !(TOOL_KEYWORDS[name]?.length > 0)),
      [],
      "new Revenue tools must have explicit discovery keywords",
    );
  });
});
