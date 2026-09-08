/** A ceiling set by the surface starting a turn, never by model-written arguments. */
export type MailDeliveryMode = "draft" | "reply" | "triage";

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
  if (!mode || mode === "reply") return null;
  if (SEND_TOOLS.has(toolName)) {
    return "This work permits preparation only. Save a draft for a Member to review; sending is not authorized for this turn.";
  }
  if (mode === "triage" && DRAFT_TOOLS.has(toolName)) {
    return "This work is triage only. Filing mail is allowed; composing a reply is not.";
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
  if (!mode || mode === "reply") return;
  const error =
    capability === "mail.send"
      ? mailDeliveryToolError(mode, "send_mail")
      : capability === "mail.draft"
        ? mailDeliveryToolError(mode, "create_mail_draft")
        : null;
  if (error) throw new Error(error);
}
