import type { ToolScope } from "../agent/tools/index.js";

/** An explicit read allowlist: a newly added tool never gains review authority by its name. */
export const PROACTIVE_REVIEW_TOOLS = [
  "get_self",
  "list_employees",
  "list_skills",
  "list_routines",
  "get_routine",
  "list_runs",
  "get_run_report",
  "list_goals",
  "get_goal",
  "get_proactive_work",
  "list_initiatives",
  "get_initiative",
  "list_workstreams",
  "list_projects",
  "list_todos",
  "get_todo",
  "list_handoffs",
  "list_decisions",
  "get_decision",
  "list_repositories",
  "get_repository_work_session",
  "list_mail_accounts",
  "search_mail",
  "get_mail_thread",
  "list_meetings",
  "get_meeting",
  "get_meeting_transcript",
  "list_notes",
  "search_notes",
  "get_note",
  "list_resources",
  "search_resources",
  "get_resource",
  "list_bases",
  "get_base",
  "list_base_rows",
  "get_base_record",
  "list_charts",
  "get_chart",
  "list_customers",
  "get_customer",
  "list_invoices",
  "get_invoice",
  "list_estimates",
  "get_estimate",
  "list_finance_products",
  "list_finance_transactions",
  "get_finance_transaction",
  "list_contacts",
  "search_contacts",
  "get_contact",
  "get_contact_timeline",
  "list_deals",
  "get_deal",
  "list_activities",
  "get_activity",
  "list_follow_ups",
  "get_revenue_report",
  "get_marketing_overview",
  "list_marketing_campaigns",
  "get_marketing_campaign",
  "list_marketing_experiments",
  "list_signature_envelopes",
  "get_signature_envelope",
  "request_decision",
  "request_work_review",
  "list_work_reviews",
] as const;

export const PROACTIVE_REVIEW_BRIEF = `This is a proactive review, before human approval. Read the current evidence and identify a useful next step. You cannot change company records, draft or send messages, edit a Repository, start a Work session, delegate, schedule follow-ups, or perform the proposed work yet. Older Soul, Skill and Routine instructions do not override this boundary.
When action is warranted, use request_work_review with a short action title, what happened (including source IDs and any real deadline), and a concrete plan explaining scope, expected result and relevant risks. The plan must let a human understand exactly what they would authorize. Check list_work_reviews, existing Workstreams and Decisions first so you can reuse existing work and avoid repeating declined or completed work without new evidence. An owner or admin must approve the work in the Decision stack. A Decision answer, another AI Employee, and a Waiver cannot grant this approval.
Use request_decision only for missing information or a business choice. Its answer does not start work from this review. Propose the resulting work separately for human approval. If nothing actionable changed, finish quietly. A submitted review is proposed work, never completed work.`;

export function proactiveReviewToolError(
  enabled: boolean | undefined,
  toolName: string,
): string | null {
  if (!enabled || (PROACTIVE_REVIEW_TOOLS as readonly string[]).includes(toolName)) return null;
  return "Proactive work needs human approval. Read the evidence, then use request_work_review to put a concrete plan in the Decision stack. This turn cannot change records or start work.";
}

export function proactiveReviewToolScope(enabled: boolean | undefined): ToolScope | undefined {
  return enabled
    ? { genosynTools: [...PROACTIVE_REVIEW_TOOLS], surfaceOnly: true, discovery: true }
    : undefined;
}
