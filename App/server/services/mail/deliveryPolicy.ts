/** A ceiling set by the surface starting a turn, never by model-written arguments. */
export type MailDeliveryMode = "draft" | "reply" | "triage" | "review";

/** Inert records may be saved, but their automatic workers must not shed a ceiling. */
export function mailDeliveryAllowsDeferredWork(mode: MailDeliveryMode | null | undefined): boolean {
  return mode == null || mode === "reply";
}

const SEND_TOOLS = new Set([
  "send_mail",
  "send_invoice",
  "send_estimate",
  "send_signature_envelope",
  "remind_signature_recipient",
  "send_sequence_step",
  "send_campaign",
]);
const DRAFT_TOOLS = new Set(["create_mail_draft", "edit_mail_draft"]);
const REVIEW_COMPOSE_TOOLS = new Set(["request_mail_review", "revise_mail_review"]);
// A new background turn would shed this turn's ceiling. Standing work must
// already have its own independently configured authority.
const DEFERRED_AUTHORITY_TOOLS = new Set([
  "schedule_wakeup",
  "create_routine",
  "update_routine",
  "create_pipeline",
  "update_pipeline",
  "create_sequence",
  "update_sequence",
  "enroll_in_sequence",
  "enroll_contacts",
  "bulk_enroll_sequence",
  "create_signal",
  "update_signal",
  "create_handoff",
  "request_handoff",
  "handoff",
  "decide_decision",
  "send_message",
  "send_workspace_message",
  "run_pipeline",
  "replace_sequence_steps",
  "test_signal",
  "restore_signal",
]);

export function mailDeliveryToolError(
  mode: MailDeliveryMode | null | undefined,
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  if (!mode) return null;
  // `draft` is the legacy persisted Routine value. Runtime policy maps it to
  // `review`, and enforcement repeats that mapping so an already-minted token
  // cannot create a provider draft during a rolling upgrade.
  const enforcedMode = mode === "draft" ? "review" : mode;
  if (enforcedMode === "reply" && DRAFT_TOOLS.has(toolName)) {
    return "Reply work may send when authorized or use request_mail_review for a human. It must not create a Gmail or IMAP draft.";
  }
  if (enforcedMode !== "reply" && SEND_TOOLS.has(toolName)) {
    if (enforcedMode === "review") {
      return "This email must return to the Decision stack for a human. Use request_mail_review with the exact reply; do not send it or create a mailbox draft.";
    }
    return "This work is triage only. Sending is not authorized for this turn.";
  }
  if ((enforcedMode === "triage" || enforcedMode === "review") && DRAFT_TOOLS.has(toolName)) {
    if (enforcedMode === "triage") {
      return "This work is triage only. Filing mail is allowed; composing a reply is not.";
    }
    return "Keep the proposed reply inside Genosyn's Decision stack with request_mail_review. Do not create a draft in the mailbox.";
  }
  if (enforcedMode === "triage" && REVIEW_COMPOSE_TOOLS.has(toolName)) {
    return "This work is triage only. It cannot prepare or revise an email for sending.";
  }
  if (DEFERRED_AUTHORITY_TOOLS.has(toolName)) {
    return "This work cannot start or change separate automation or delegate its delivery authority. Record remaining work in a Workstream for the approved standing Routine or a Member to continue.";
  }
  if (
    (toolName === "create_recurring_invoice" && args.autoSend === true) ||
    (toolName === "update_recurring_invoice" && args.autoSend !== false)
  ) {
    return "This work cannot enable or preserve automatic invoice sending while changing a schedule. Set autoSend false for review.";
  }
  return null;
}

export function assertMailDeliveryCapability(
  mode: MailDeliveryMode | null | undefined,
  capability: string,
): void {
  if (!mode) return;
  const error =
    capability === "mail.send"
      ? mailDeliveryToolError(mode, "send_mail")
      : capability === "mail.draft"
        ? mailDeliveryToolError(mode, "create_mail_draft")
        : null;
  if (error) throw new Error(error);
}
