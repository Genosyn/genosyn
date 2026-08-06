import { In } from "typeorm";
import { AppDataSource } from "../../../db/datasource.js";
import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import { EmployeeBaseGrant } from "../../../db/entities/EmployeeBaseGrant.js";
import { EmployeeMailAccountGrant } from "../../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeFinanceGrant } from "../../../db/entities/EmployeeFinanceGrant.js";
import { EmployeeRevenueGrant } from "../../../db/entities/EmployeeRevenueGrant.js";
import { EmployeeConnectionGrant } from "../../../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../../../db/entities/IntegrationConnection.js";
import { EXPLORE_PROVIDERS } from "../../explore.js";

/**
 * Which of an employee's tools can only ever answer "No grant".
 *
 * Grants are enforced when a tool is *called*, not when it's offered: an
 * employee with no Base grants still gets handed every `base_*` tool, and
 * `loadGrantedBase` in `routes/mcpInternal.ts` turns each call into a 403.
 *
 * ## Two consumers, one source
 *
 * 1. `sinkGrantDeadTools` in `tools/index.ts` sorts these to the back, so that
 *    if `trimToProviderCap` ever has to cut, it cuts the tools that could only
 *    have returned 403 anyway.
 * 2. `find_tools` (see `discovery.ts`) applies the same set as a **rank
 *    penalty and an annotation**. That is the consumer that matters now: once
 *    the catalogue is deferred, ordering an array is nearly a no-op, but
 *    telling the model "you hold no grant for this today" before it spends a
 *    call is not.
 *
 * ## Never a filter
 *
 * Demote, annotate, deprioritise — never remove. `create_base` auto-grants its
 * creator, so an employee with no Bases at assembly time can hold one two steps
 * later, and a tool filtered out at build time would stay gone for the rest of
 * the run. Wrongly calling a live tool dead loses a capability; wrongly calling
 * a dead tool live costs a rank position. When in doubt, live.
 *
 * Integration tools never appear here: `/integrations/_list` only discovers
 * tools for connections the employee already holds a grant on, so they are
 * grant-scoped before they reach us.
 */

/**
 * Tools whose every path routes through `loadGrantedBase` / `loadGrantedRecord`.
 *
 * Manifest names, now that the collapsed families are retired. Deliberately
 * excludes `list_bases` (it filters to what you hold), `get_base` and
 * `create_base` (which auto-grants its creator) — those work on a bare
 * employee, which is exactly why the old family-level set was so small.
 */
const BASE_GATED_TOOLS = new Set([
  "create_base_table",
  "update_base_table",
  "delete_base_table",
  "add_base_field",
  "update_base_field",
  "delete_base_field",
  "list_base_rows",
  "create_base_row",
  "update_base_row",
  "delete_base_row",
  "get_base_record",
  "list_record_comments",
  "create_record_comment",
  "delete_record_comment",
  "list_record_attachments",
  "attach_file_to_record",
  "read_record_attachment",
  "delete_record_attachment",
]);

/**
 * The mail surface (Email section, M25): every tool needs an
 * `EmployeeMailAccountGrant`. There is no ungated create to keep it alive, so
 * even `list_mail_accounts` and `search_mail` can only answer "no grant" for an
 * employee with zero mailboxes.
 */
const MAIL_GATED_TOOLS = new Set([
  "list_mail_accounts",
  "search_mail",
  "get_mail_thread",
  "create_mail_draft",
  "edit_mail_draft",
  "update_mail_thread",
  "send_mail",
  "suggest_mail_actions",
  "scan_revenue_mail_documents",
  "list_revenue_document_candidates",
  "review_revenue_document_candidate",
]);

/**
 * The finance surface (Finance section, M19): every tool — reads included —
 * answers to an `EmployeeFinanceGrant`.
 */
const FINANCE_GATED_TOOLS = new Set([
  "list_finance_accounts",
  "list_finance_transactions",
  "get_finance_transaction",
  "review_finance_transaction",
  "get_finance_report",
  "list_invoices",
  "get_invoice",
  "list_customers",
  "get_customer",
  "create_customer",
  "update_customer",
  "create_estimate",
  "create_invoice",
  "send_invoice",
  "record_payment",
  "void_invoice",
  "list_commercial_value_backlog",
  "propose_finance_commercial_values",
]);

/**
 * The revenue surface (Revenue section, M32): every tool — reads included —
 * answers to an `EmployeeRevenueGrant`. Same shape as finance: one grant row
 * per employee over one company-wide subsystem, and no ungated create that
 * could bring the surface to life for an employee holding nothing.
 */
const REVENUE_GATED_TOOLS = new Set([
  "list_follow_ups",
  "create_follow_up",
  "update_follow_up",
  "list_follow_up_views",
  "create_follow_up_view",
  "update_follow_up_view",
  "delete_follow_up_view",
  "list_revenue_accounts",
  "create_revenue_account",
  "get_revenue_account",
  "update_revenue_account",
  "archive_revenue_account",
  "merge_revenue_accounts",
  "list_contacts",
  "search_contacts",
  "get_contact",
  "get_contact_timeline",
  "list_deals",
  "get_deal",
  "get_deal_board",
  "list_deal_stages",
  "list_sequences",
  "list_signals",
  "get_revenue_report",
  "create_contact",
  "update_contact",
  "create_deal",
  "update_deal",
  "move_deal_stage",
  "log_activity",
  "add_deal_contact",
  "enroll_in_sequence",
  "suppress_email",
  "list_revenue_imports",
  "get_revenue_import",
  "preview_revenue_rows_import",
  "run_revenue_rows_import",
  "preview_linked_revenue_rows_import",
  "run_linked_revenue_rows_import",
  "list_revenue_import_rows",
  "export_revenue_import_reconciliation",
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
  "preview_historical_deal_import",
  "run_historical_deal_import",
  "list_deal_history",
  "list_deal_history_coverage",
  "preview_deal_history_backfill",
  "backfill_deal_history",
  "export_revenue_snapshot",
  "propose_revenue_account_domains",
  "preview_revenue_firmographics",
  "propose_revenue_firmographics",
  "list_revenue_firmographic_lookups",
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
]);

/** Explore's ad-hoc database tools need at least one Connection Grant. */
const EXPLORE_CONNECTION_GATED_TOOLS = new Set([
  "get_explore_schema",
  "run_explore_query",
  "create_chart",
]);

/**
 * Fail at boot if any gated name has drifted away from the manifest.
 *
 * This module's own doc comment used to admit that nothing linked these sets to
 * the tools they name, so a rename would silently stop demoting a dead tool.
 * That mattered little when the sets held eight family names; it matters now
 * that they hold sixty-one granular ones and feed `find_tools`' rank penalty as
 * well as the trim ordering.
 */
export function assertGrantSetsResolve(): void {
  const known = new Set(STATIC_TOOLS.map((t) => t.name));
  const unknown = [
    ...BASE_GATED_TOOLS,
    ...MAIL_GATED_TOOLS,
    ...FINANCE_GATED_TOOLS,
    ...REVENUE_GATED_TOOLS,
    ...EXPLORE_CONNECTION_GATED_TOOLS,
  ].filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `grantDead.ts names ${unknown.length} tool(s) that are not in STATIC_TOOLS: ` +
        `${unknown.join(", ")}. Fix the rename — a stale entry here means a tool that can ` +
        `only answer 403 is never demoted, and one that works may be.`,
    );
  }
}

assertGrantSetsResolve();

/**
 * The model-facing names that are dead weight for this employee right now.
 *
 * Fails safe: any error means we return an empty set and treat everything as
 * live. Wrongly calling a tool dead could drop one the employee needs, whereas
 * wrongly calling a dead tool live only wastes a slot — so when in doubt, live.
 */
export async function deadToolNames(employeeId: string): Promise<Set<string>> {
  try {
    const dead = new Set<string>();
    const bases = await AppDataSource.getRepository(EmployeeBaseGrant).count({
      where: { employeeId },
    });
    if (bases === 0) for (const t of BASE_GATED_TOOLS) dead.add(t);
    const mailboxes = await AppDataSource.getRepository(EmployeeMailAccountGrant).count({
      where: { employeeId },
    });
    if (mailboxes === 0) for (const t of MAIL_GATED_TOOLS) dead.add(t);
    const finance = await AppDataSource.getRepository(EmployeeFinanceGrant).count({
      where: { employeeId },
    });
    if (finance === 0) for (const t of FINANCE_GATED_TOOLS) dead.add(t);
    const revenue = await AppDataSource.getRepository(EmployeeRevenueGrant).count({
      where: { employeeId },
    });
    if (revenue === 0) for (const t of REVENUE_GATED_TOOLS) dead.add(t);
    const connectionGrants = await AppDataSource.getRepository(EmployeeConnectionGrant).find({
      where: { employeeId },
      select: ["connectionId"],
    });
    const exploreConnections = connectionGrants.length
      ? await AppDataSource.getRepository(IntegrationConnection).count({
          where: {
            id: In(connectionGrants.map((grant) => grant.connectionId)),
            provider: In(EXPLORE_PROVIDERS as readonly string[]),
          },
        })
      : 0;
    if (exploreConnections === 0) {
      for (const tool of EXPLORE_CONNECTION_GATED_TOOLS) dead.add(tool);
    }
    return dead;
  } catch {
    return new Set();
  }
}
