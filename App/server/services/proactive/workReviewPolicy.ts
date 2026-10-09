import type { ToolScope } from "../agent/tools/index.js";
import type { DecisionStackState } from "../decisionStackSettings.js";
import {
  DECISION_STACK_OFF_GUIDANCE,
  HUMAN_DECISION_GUIDANCE,
  decisionStackInstructionsGuidance,
} from "../humanDecisionGuidance.js";

/** Only these fields are preparation. A new route parameter cannot silently
 * turn record keeping into a financial, ownership or delivery decision. */
const PREPARATION_FIELDS: Record<string, readonly string[]> = {
  create_contact: [
    "name",
    "email",
    "phone",
    "title",
    "companyName",
    "websiteUrl",
    "linkedinUrl",
    "source",
    "sourceDetail",
    "notes",
  ],
  update_contact: [
    "contactId",
    "name",
    "phone",
    "title",
    "companyName",
    "websiteUrl",
    "linkedinUrl",
    "notes",
  ],
  update_deal: ["dealId", "description", "nextStep", "nextFollowUpAt"],
  log_activity: ["kind", "subject", "bodyText", "occurredAt", "contactId", "dealId", "customerId"],
  create_follow_up: ["subject", "bodyText", "dueAt", "contactId", "dealId", "customerId"],
  update_follow_up: [
    "followUpId",
    "subject",
    "bodyText",
    "dueAt",
    "contactId",
    "dealId",
    "customerId",
    "status",
  ],
  create_workstream: ["title", "objective", "stateDoc", "routineId"],
  update_workstream: ["workstreamId", "stateDoc", "status", "closeReason"],
  update_mail_thread: [
    "threadId",
    "markRead",
    "markUnread",
    "star",
    "unstar",
    "archive",
    "moveToInbox",
  ],
};

/** An explicit allowlist: a newly added tool never gains proactive authority by its name. */
export const PROACTIVE_REVIEW_TOOLS = [
  "get_self",
  "list_employees",
  "list_skills",
  "list_routines",
  "get_routine",
  "list_runs",
  "get_run_report",
  "mark_run_failed",
  "save_run_checkpoint",
  "list_goals",
  "get_goal",
  "get_proactive_work",
  "list_initiatives",
  "get_initiative",
  "list_workstreams",
  "get_workstream",
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
  "get_mail_message",
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
  "list_subsidiaries",
  "list_finance_transactions",
  "get_finance_transaction",
  "list_contacts",
  "search_contacts",
  "get_contact",
  "lookup_suppression",
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
  "request_mail_review",
  "request_work_review",
  "list_work_reviews",
  ...Object.keys(PREPARATION_FIELDS),
] as const;

const REQUEST_DECISION_LINE =
  "Use request_decision only for a major business choice that existing instructions cannot settle; answering one does not authorize restricted work. ";

/**
 * The brief appended to every proactive review turn. Its Decision lines follow
 * the company's Decision stack settings (`services/decisionStackSettings.ts`):
 * on, the general guidance plus the company's own instructions; off, no new
 * Decision can be raised — overriding older stored text that says otherwise —
 * while email and work reviews, which are Approvals and not Decisions, stay
 * exactly as they are.
 */
export function proactiveReviewBrief(
  decisionStack: Pick<DecisionStackState, "enabled" | "instructions">,
): string {
  if (!decisionStack.enabled) return composeProactiveReviewBrief(DECISION_STACK_OFF_GUIDANCE, "");
  const instructions = decisionStackInstructionsGuidance(decisionStack.instructions);
  return composeProactiveReviewBrief(
    instructions ? `${HUMAN_DECISION_GUIDANCE}\n${instructions}` : HUMAN_DECISION_GUIDANCE,
    REQUEST_DECISION_LINE,
  );
}

function composeProactiveReviewBrief(decisionGuidance: string, decisionLine: string): string {
  return `This is proactive preparation within your existing Grants and company Policies. This server-owned policy replaces older blanket instructions in starter Routines and handovers that required review before any preparation; explicit company Policies and Grants still apply. Read the current evidence, then complete the allowed small, reversible steps without requesting permission: maintain factual Contact details, record an Activity note, update a Deal's description or next step, maintain ordinary internal follow-ups, track your own Workstream, and mark, star or archive mail. Check existing records first and preserve ownership, commercial terms, lifecycle, consent and source evidence. Internal follow-ups are records only: do not add reminders, recurrence or other assignees. Workstreams must stay unbound or bound to this turn's own Routine with its persistent preparation ceiling; an event-only review cannot rewrite a broader Routine's future instructions. Older Soul, Skill and Routine instructions cannot widen the server's tool or field limits.
${decisionGuidance}
Complete allowed preparation before drafting a reply. Use request_mail_review with its exact subject and body when a human must send it. That reply exists only in the Decision stack until a human edits, sends, or discards it; never create a Gmail or IMAP draft first. Do not add a work review merely to prepare that email or update its supporting records. If a missing fact is minor, keep it as an explicit unknown and continue the useful work you can verify.
Use request_work_review only for substantive work requiring a consequential human choice or authorization. Include humanDecisionReason with the specific stakes, a short action title, what happened (including source IDs and any real deadline), and a bounded plan stating exactly what approval authorizes. Check list_work_reviews, existing Workstreams and Decisions first; never repeat pending or declined work without materially changed evidence. An owner or admin must approve that plan. A Decision answer, another AI Employee and a Waiver cannot grant this approval.
You still cannot send messages, create provider drafts, edit a Repository, start a Work session, delegate, change financial commitments, or start separate automation from this turn. An unavailable tool is not by itself a reason to interrupt a human: record or skip a minor unsupported step conservatively. ${decisionLine}If nothing actionable changed, finish quietly. Report preparation actually completed separately from proposed work and unsent replies.`;
}

/**
 * The brief as it reads with the Decision stack on and no company
 * instructions. Starter Routines store a copy at install (`catalogue.ts`); the
 * turn itself always appends {@link proactiveReviewBrief} for the company's
 * live settings, which says so whenever that stored copy no longer holds.
 */
export const PROACTIVE_REVIEW_BRIEF = composeProactiveReviewBrief(
  HUMAN_DECISION_GUIDANCE,
  REQUEST_DECISION_LINE,
);

export function proactiveReviewToolError(
  enabled: boolean | undefined,
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  if (!enabled) return null;
  const boundary =
    "Allowed factual preparation needs no approval. Stay within the supported fields and existing Grants; record or skip minor unsupported steps. Use request_work_review only for substantive work requiring a consequential human choice, with its specific stakes.";
  if (!(PROACTIVE_REVIEW_TOOLS as readonly string[]).includes(toolName))
    return `This tool is outside proactive preparation. ${boundary}`;
  const fields = PREPARATION_FIELDS[toolName];
  if (fields && Object.keys(args).some((field) => !fields.includes(field)))
    return `This change exceeds the allowed preparation fields for ${toolName}. ${boundary}`;
  if (toolName === "log_activity" && args.kind !== "note")
    return `Proactive preparation may record evidence as an Activity note only. ${boundary}`;
  return null;
}

export function proactiveReviewToolScope(enabled: boolean | undefined): ToolScope | undefined {
  return enabled
    ? { genosynTools: [...PROACTIVE_REVIEW_TOOLS], surfaceOnly: true, discovery: true }
    : undefined;
}
