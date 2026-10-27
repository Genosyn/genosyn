import type { ToolScope } from "./agent/tools/index.js";

/**
 * The read-only surface of a turn in which one AI Employee talks to its
 * colleagues: a turn in a group discussion, or an answer to a colleague's
 * `ask_colleague` question.
 *
 * Both are talk. Everything an employee says there is read by another AI
 * Employee — not a Member — who then acts on it in its own turn, so letting
 * the talking turn act as well would make every discussion a path around the
 * gates the acting turn meets: a colleague's message could ask for a send, a
 * schedule or a payment, and the employee reading it would hold the tools to
 * do it with nobody but another model having asked. Instead the talking turn
 * can read — to check a number, open a record, look something up — and
 * nothing else. Work the talk decides on starts afterwards as ordinary chat
 * turns, which carry every Approval, Decision, delivery limit and taint gate
 * the product already has.
 *
 * The same discipline as `proactive/workReviewPolicy.ts`: an explicit
 * allowlist, so a tool added to the product later never gains a place here by
 * its name; enforced twice, once where the tool list is built and again at the
 * MCP seam, so a `call_tool` naming something else is refused all the same.
 */

/** What the talking turn is. Carried on its MCP token. */
export type CollaborationTurn = {
  kind: "discussion" | "consult";
  /** The `GroupDiscussion` id, or the consult's own id. */
  id: string;
};

/**
 * Read tools a talking turn may use. Every one only reads; each still meets
 * its own Grant check and, under Member authority, the Member's access.
 *
 * Deliberately absent: every write (including Memory, Journal, Workstreams and
 * Decisions), delivery (mail, texts, calls, workspace messages), delegation,
 * `ask_colleague` itself — a colleague answering a question cannot ask a
 * third, so talk is never more than one hop deep — and the applicant tools,
 * whose personal data has no place in a group chat.
 *
 * The two web readers are here on purpose: checking a public fact is often the
 * point of asking. They taint the turn, and the taint travels with what the
 * turn wrote (`ChannelMessage.tainted`), so the acting turn that reads it later
 * still has its sinks held for review.
 */
export const COLLABORATION_READ_TOOLS = [
  // Who is who, and what the company is aiming at.
  "get_self",
  "list_employees",
  "list_members",
  "list_teams",
  "list_skills",
  "list_routines",
  "get_routine",
  "list_runs",
  "get_run_report",
  "list_goals",
  "get_goal",
  // Work already in flight.
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
  "list_journal",
  "get_journal_entry",
  "list_memory",
  // What the company knows.
  "list_notebooks",
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
  "list_record_comments",
  "list_charts",
  "get_chart",
  "run_chart",
  "list_dashboards",
  "get_dashboard",
  "list_repositories",
  "list_workspace_channels",
  // Mail and meetings, as far as Grants reach.
  "list_mail_accounts",
  "search_mail",
  "get_mail_thread",
  "get_mail_message",
  "list_meetings",
  "list_scheduling_calendars",
  "check_calendar_availability",
  "get_meeting",
  "get_meeting_transcript",
  // Finance.
  "list_finance_accounts",
  "list_finance_transactions",
  "get_finance_transaction",
  "get_finance_report",
  "list_banking_accounts",
  "list_banking_transactions",
  "get_bank_transaction_matches",
  "list_tax_rates",
  "list_vendors",
  "list_bills",
  "get_bill",
  "list_subsidiaries",
  "list_invoices",
  "get_invoice",
  "list_recurring_invoices",
  "get_recurring_invoice",
  "list_customers",
  "get_customer",
  "list_estimates",
  "get_estimate",
  "list_finance_products",
  // Revenue and marketing.
  "list_contacts",
  "search_contacts",
  "get_contact",
  "get_contact_timeline",
  "list_activities",
  "get_activity",
  "list_deals",
  "get_deal",
  "get_deal_board",
  "list_deal_stages",
  "list_sequences",
  "list_sequence_enrollments",
  "list_routine_triggers",
  "get_sequence",
  "list_signals",
  "get_signal",
  "get_revenue_report",
  "list_follow_ups",
  "list_revenue_accounts",
  "get_revenue_account",
  "list_partnerships",
  "get_partnership",
  "lookup_suppression",
  "get_marketing_overview",
  "list_marketing_campaigns",
  "get_marketing_campaign",
  "list_marketing_creatives",
  "list_marketing_experiments",
  // Signing and hiring, without applicants.
  "list_signature_envelopes",
  "get_signature_envelope",
  "list_openings",
  "get_opening",
  // Public facts. These taint the turn; see above.
  "search_web",
  "fetch_web_page",
] as const;

const READ_TOOL_SET = new Set<string>(COLLABORATION_READ_TOOLS);

/** The narrowed tool scope for a talking turn, or undefined for any other. */
export function collaborationToolScope(
  turn: CollaborationTurn | null | undefined,
): ToolScope | undefined {
  if (!turn) return undefined;
  return { genosynTools: [...COLLABORATION_READ_TOOLS], surfaceOnly: true, discovery: true };
}

/**
 * The MCP seam's answer to a talking turn calling `toolName`: null to let it
 * through, or the refusal the model reads. The refusal tells it what to do
 * instead, so a refused write becomes a proposal rather than a retry.
 */
export function collaborationToolError(
  turn: CollaborationTurn | null | undefined,
  toolName: string | null,
): string | null {
  if (!turn) return null;
  if (toolName && READ_TOOL_SET.has(toolName)) return null;
  return turn.kind === "discussion"
    ? "This is a group discussion: your turn can read, not act. Say what should be done and who should do it — the Member can start that work from the outcome."
    : "You are answering a colleague's question: this turn can read, not act. Say what you would do, and let your colleague or a Member start it.";
}
