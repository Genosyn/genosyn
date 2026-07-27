import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import {
  hasSafeDirectWriteProvenance,
  proposeStripeCommercialValuesToolSchema,
} from "../../../routes/mcpInternal.js";
import { TOOL_DOMAINS, TOOL_KEYWORDS } from "./toolIndex.js";

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

describe("Revenue AI capability contracts", () => {
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
    includesContract("backfill_deal_history", ["BACKFILL"]);
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
      "json",
      "csv",
    ]);
  });

  test("domain, commercial value, duplicate, Gmail, and provenance workflows are reachable", () => {
    includesContract("propose_revenue_account_domains", [
      "accountIds",
      "verifiedContactIds",
      "followWebsiteRedirects",
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
    assert.deepEqual(stripeSchema.required, ["connectionId", "confirm"]);
    assert.equal(
      proposeStripeCommercialValuesToolSchema.safeParse({ confirm: "PROPOSE" }).success,
      false,
    );
    assert.equal(
      proposeStripeCommercialValuesToolSchema.safeParse({
        connectionId: "11111111-1111-4111-8111-111111111111",
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
      "preview_historical_deal_import",
      "run_historical_deal_import",
      "list_deal_history",
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
  });
});
