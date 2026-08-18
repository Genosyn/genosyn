/**
 * Explicit interactive-Member policy for every built-in Genosyn tool.
 *
 * This registry is deliberately literal rather than name-prefix based. A new
 * tool therefore starts unclassified and is denied to interactive Members
 * until its human-route equivalent and resource model have been reviewed.
 * Routine Runs and explicitly authenticated external MCP sessions continue to
 * use the AI Employee's Grants without a Member intersection.
 */
export type MemberToolPolicy =
  | "member"
  | "admin"
  | "finance.read"
  | "finance.write"
  | "project"
  | "attachment"
  | "channel";

const MEMBER_TOOLS = [
  "get_self",
  "list_employees",
  "list_skills",
  "list_routines",
  "get_routine",
  "create_project",
  "list_bases",
  "get_base",
  "create_base",
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
  "list_teams",
  "list_handoffs",
  "create_handoff",
  "complete_handoff",
  "decline_handoff",
  "cancel_handoff",
  // The Decision Stack is member-level on the human route too, and every row is
  // company-scoped. A Member driving a turn can raise, read back, and retract a
  // question exactly as they could from the Decisions page.
  "request_decision",
  "list_decisions",
  "cancel_decision",
  // The repository work-session tools are bounded by the session on the turn's
  // MCP token, not by their arguments: they act on one worktree, they have no
  // parameter for reaching another repository, and outside a session they
  // refuse to run at all. The authority decision was already made when a
  // Member started the session from the Repository page, so intersecting it a
  // second time here would only mean the tools fail mid-turn. Repository
  // *configuration* stays admin-only, and nothing here can reach the remote.
  "repository_list_files",
  "repository_read_file",
  "repository_write_file",
  "repository_delete_file",
  "repository_search",
  "repository_commit",
  "list_notebooks",
  "list_notes",
  "search_notes",
  "get_note",
  "create_note",
  "update_note",
  "delete_note",
  "list_resources",
  "search_resources",
  "get_resource",
  "export_resource",
  "create_resource",
  "update_resource",
  "delete_resource",
  "list_signature_envelopes",
  "get_signature_envelope",
  "draft_signature_envelope",
  "send_signature_envelope",
  "remind_signature_recipient",
  "void_signature_envelope",
  "list_mail_accounts",
  "search_mail",
  "get_mail_thread",
  "read_mail_attachment",
  "create_mail_draft",
  "edit_mail_draft",
  "update_mail_thread",
  "send_mail",
  "suggest_mail_actions",
  "list_contacts",
  "search_contacts",
  "get_contact",
  "get_contact_timeline",
  "list_activities",
  "get_activity",
  "update_activity",
  "delete_activity",
  "export_activities",
  "list_deals",
  "get_deal",
  "get_deal_board",
  "list_deal_stages",
  "create_deal_stage",
  "update_deal_stage",
  "reorder_deal_stages",
  "archive_deal_stage",
  "list_sequences",
  "get_sequence",
  "create_sequence",
  "update_sequence",
  "replace_sequence_steps",
  "archive_sequence",
  "list_signals",
  "get_signal",
  "create_signal",
  "update_signal",
  "list_signal_events",
  "test_signal",
  "archive_signal",
  "restore_signal",
  "get_revenue_report",
  "list_follow_ups",
  "list_follow_up_views",
  "create_follow_up_view",
  "update_follow_up_view",
  "delete_follow_up_view",
  "create_follow_up",
  "update_follow_up",
  "list_revenue_accounts",
  "create_revenue_account",
  "get_revenue_account",
  "update_revenue_account",
  "archive_revenue_account",
  "merge_revenue_accounts",
  "list_revenue_classifications",
  "create_revenue_classification",
  "update_revenue_classification",
  "list_revenue_custom_fields",
  "create_revenue_custom_field",
  "update_revenue_custom_field",
  "install_base_migration_custom_fields",
  "set_revenue_custom_fields",
  "list_partnerships",
  "get_partnership",
  "create_partnership",
  "update_partnership",
  "add_partnership_contact",
  "list_revenue_documents",
  "link_revenue_document",
  "get_revenue_document",
  "update_revenue_document",
  "delete_revenue_document",
  "download_revenue_document",
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
  "backfill_deal_history",
  "list_deal_history_coverage",
  "preview_deal_history_backfill",
  "export_revenue_snapshot",
  "propose_revenue_account_domains",
  "preview_revenue_firmographics",
  "propose_revenue_firmographics",
  "list_revenue_firmographic_lookups",
  "scan_revenue_duplicates",
  "list_revenue_duplicate_candidates",
  "dismiss_revenue_duplicate_candidate",
  "scan_revenue_mail_documents",
  "list_revenue_document_candidates",
  "review_revenue_document_candidate",
  "list_revenue_imports",
  "get_revenue_import",
  "list_revenue_import_rows",
  "export_revenue_import_reconciliation",
  "preview_base_revenue_import",
  "run_base_revenue_import",
  "preview_linked_base_revenue_import",
  "run_linked_base_revenue_import",
  "preview_revenue_rows_import",
  "run_revenue_rows_import",
  "preview_linked_revenue_rows_import",
  "run_linked_revenue_rows_import",
  "migrate_base_revenue_attachments",
  "rollback_revenue_import",
  "create_contact",
  "update_contact",
  "create_deal",
  "update_deal",
  "move_deal_stage",
  "log_activity",
  "add_deal_contact",
  "enroll_in_sequence",
  "suppress_email",
  "get_marketing_overview",
  "list_marketing_campaigns",
  "get_marketing_campaign",
  "create_marketing_campaign",
  "update_marketing_campaign",
  "list_marketing_creatives",
  "create_marketing_creative",
  "update_marketing_creative",
  "list_marketing_experiments",
  "create_marketing_experiment",
  "update_marketing_experiment",
  "record_marketing_performance",
] as const;

const ADMIN_TOOLS = [
  "create_skill",
  "update_skill",
  "delete_skill",
  "create_routine",
  "update_routine",
  "delete_routine",
  // Memory and Journal can contain material learned under broader Grants.
  // Until entries carry resource provenance, regular delegated Members do not
  // receive them through an AI Employee.
  "list_journal",
  "add_journal_entry",
  "list_memory",
  "add_memory",
  "update_memory",
  "delete_memory",
  // Vault tools act with an AI Employee's item Grants. Until the delegated
  // Member's per-item View/Edit access is intersected in every handler, keep
  // interactive use owner/admin-only so a Member cannot borrow broader AI
  // access from chat. Routine Runs still use the EmployeeVaultGrant directly.
  "list_vault_items",
  "create_vault_login",
  "update_vault_login",
  // Code workspaces, raw data-source access, and generated files have no
  // Member-level Grant model. Their human management surfaces are privileged.
  "list_repositories",
  "send_chat_attachment",
  "list_explore_connections",
  "get_explore_schema",
  "run_explore_query",
  "list_charts",
  "get_chart",
  "run_chart",
  "create_chart",
  "update_chart",
  "delete_chart",
  "list_dashboards",
  "get_dashboard",
  "create_dashboard",
  "add_dashboard_card",
  // These Revenue enrichment tools can expose Connection-, mailbox-, or
  // Finance-derived evidence selected at runtime. There is no single
  // Member-resource ACL to intersect before inspecting the payload.
  "propose_stripe_commercial_values",
  "create_commercial_value_proposal",
  "list_revenue_field_evidence",
  "review_revenue_field_evidence",
] as const;

const FINANCE_READ_TOOLS = [
  "list_finance_accounts",
  "list_finance_transactions",
  "get_finance_transaction",
  "get_finance_report",
  "list_invoices",
  "get_invoice",
  "list_customers",
  "get_customer",
  "list_commercial_value_backlog",
] as const;

const FINANCE_WRITE_TOOLS = [
  "review_finance_transaction",
  "create_customer",
  "update_customer",
  "create_estimate",
  "create_invoice",
  "send_invoice",
  "record_payment",
  "void_invoice",
  "propose_finance_commercial_values",
] as const;

const PROJECT_TOOLS = ["list_projects", "list_todos", "create_todo", "update_todo"] as const;
/**
 * The open web carries no company data in either direction, so it needs no
 * Member intersection beyond an authenticated one. The risk these tools do
 * carry — a hostile page trying to steer the model, or a URL aimed at the
 * operator's internal network — is answered where it lives: the outbound
 * guard in `lib/outboundUrl.ts` and the untrusted-content framing on every
 * result, both of which apply to Routine Runs identically.
 */
const WEB_TOOLS = ["search_web", "fetch_web_page", "download_web_file"] as const;
const ATTACHMENT_TOOLS = [
  "read_pdf_fields",
  "fill_pdf_form",
  "read_pdf_layout",
  "overlay_pdf_text",
  "read_docx",
  "edit_docx",
  "create_docx",
] as const;
/**
 * Workspace chat has its own per-channel participant model. Each handler must
 * intersect the requesting Member's visibility with the acting AI Employee's
 * visibility. Keeping the tools in a distinct policy bucket makes a newly
 * added channel operation fail the exhaustive policy test until that
 * intersection has been reviewed explicitly.
 */
const CHANNEL_TOOLS = [
  "list_workspace_channels",
  "create_workspace_channel",
  "rename_workspace_channel",
  "archive_workspace_channel",
  "send_workspace_message",
] as const;

const entries: Array<readonly [string, MemberToolPolicy]> = [
  ...MEMBER_TOOLS.map((name) => [name, "member"] as const),
  ...ADMIN_TOOLS.map((name) => [name, "admin"] as const),
  ...FINANCE_READ_TOOLS.map((name) => [name, "finance.read"] as const),
  ...FINANCE_WRITE_TOOLS.map((name) => [name, "finance.write"] as const),
  ...PROJECT_TOOLS.map((name) => [name, "project"] as const),
  ...WEB_TOOLS.map((name) => [name, "member"] as const),
  ...ATTACHMENT_TOOLS.map((name) => [name, "attachment"] as const),
  ...CHANNEL_TOOLS.map((name) => [name, "channel"] as const),
];

export const MEMBER_TOOL_AUTHORITY = new Map<string, MemberToolPolicy>();
for (const [name, policy] of entries) {
  if (MEMBER_TOOL_AUTHORITY.has(name)) {
    throw new Error(`Duplicate interactive Member tool policy: ${name}`);
  }
  MEMBER_TOOL_AUTHORITY.set(name, policy);
}

export function memberToolPolicy(name: string): MemberToolPolicy | null {
  return MEMBER_TOOL_AUTHORITY.get(name) ?? null;
}

/** Internal callbacks used only by the privileged browser bridge. */
const MEMBER_INTERNAL_CALLBACK_AUTHORITY = new Map<string, MemberToolPolicy>([
  ["queue_browser_approval", "admin"],
  ["check_browser_approval", "admin"],
  ["claim_browser_approval", "admin"],
  ["finish_browser_approval", "admin"],
]);

export function memberInternalCallbackPolicy(name: string): MemberToolPolicy | null {
  return MEMBER_INTERNAL_CALLBACK_AUTHORITY.get(name) ?? null;
}
