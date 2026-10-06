import type { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { redactSensitiveText } from "../approvalRedaction.js";

export type MailAnalysisPhase = "started" | "completed" | "failed";

/** A presentation-only description; never an executable action or model transcript. */
export type MailAnalysisWorkDetails = {
  kind: "email";
  status: MailAnalysisPhase;
  purpose: string;
  category: string | null;
  summary: string | null;
  suggestedActions: string[];
  error: string | null;
  /** False for historical events whose attempt result cannot be established. */
  resultAvailable: boolean;
  durationMs: number | null;
};

export const MAIL_ANALYSIS_PURPOSE =
  "Classifies the incoming email, summarizes what it asks for, and suggests next steps. This analysis does not send email or carry out the suggestions.";

/** Redact before truncating, so a clipped credential cannot evade the shared grammar. */
export function analysisPreview(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  // Normalize emphasized labels first: **Password:** value must not redact
  // just the closing asterisks while leaving the actual credential visible.
  const redacted = redactSensitiveText(
    value
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(?<!\w)_([^\n]+?)_(?!\w)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1"),
  )
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
}

export function analysisMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function mailAnalysisPhase(action: string): MailAnalysisPhase | null {
  if (action === "mail.analysis.started") return "started";
  if (action === "mail.analysis.completed") return "completed";
  if (action === "mail.analysis.failed") return "failed";
  return null;
}

export function emptyAnalysisDetails(status: MailAnalysisPhase): MailAnalysisWorkDetails {
  return {
    kind: "email",
    status,
    purpose: MAIL_ANALYSIS_PURPOSE,
    category: null,
    summary: null,
    suggestedActions: [],
    error: null,
    resultAvailable: false,
    durationMs: null,
  };
}

function actionLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 4)
    .map((label) => analysisPreview(label, 60))
    .filter(Boolean);
}

/**
 * Append-only attempt evidence. Re-reading the same message replaces the live
 * analysis row, so a timeline must save this small allowlist when it happens.
 * In particular, reply bodies, handover instructions, targets, and financial
 * payloads must never be copied into the audit log or this presentation shape.
 */
export function analysisAttemptSnapshot(
  row: MailInboundAnalysis,
  status: MailAnalysisPhase,
  startedAt: Date,
): Record<string, unknown> {
  const actions: unknown = (() => {
    try {
      return JSON.parse(row.actionsJson);
    } catch {
      return null;
    }
  })();
  const hasActionEvidence =
    Array.isArray(actions) &&
    actions.every(
      (action: unknown) =>
        action &&
        typeof action === "object" &&
        "label" in action &&
        typeof action.label === "string" &&
        Boolean(action.label.trim()),
    );
  return {
    version: 1,
    status,
    durationMs:
      status !== "started" && row.finishedAt
        ? Math.max(0, row.finishedAt.getTime() - startedAt.getTime())
        : null,
    ...(status === "completed"
      ? {
          category: analysisPreview(row.category, 60),
          summary: analysisPreview(row.summary, 240),
          suggestedActions: hasActionEvidence
            ? actionLabels(
                actions.map((action: unknown) =>
                  action && typeof action === "object" && "label" in action ? action.label : null,
                ),
              )
            : undefined,
        }
      : {}),
    ...(status === "failed" ? { error: analysisPreview(row.errorMessage, 500) } : {}),
  };
}

/** Reapply bounds and redaction to persisted snapshots, including older writers. */
export function analysisDetailsFromSnapshot(
  status: MailAnalysisPhase,
  value: unknown,
): MailAnalysisWorkDetails {
  const details = emptyAnalysisDetails(status);
  if (!value || typeof value !== "object" || Array.isArray(value)) return details;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== 1 || snapshot.status !== status) return details;
  const duration = snapshot.durationMs;
  details.durationMs =
    status !== "started" &&
    typeof duration === "number" &&
    Number.isSafeInteger(duration) &&
    duration >= 0
      ? duration
      : null;
  if (status === "completed") {
    // Missing fields are not evidence that an old attempt suggested nothing.
    if (
      typeof snapshot.summary !== "string" ||
      !snapshot.summary.trim() ||
      !Array.isArray(snapshot.suggestedActions) ||
      !snapshot.suggestedActions.every((label) => typeof label === "string" && label.trim())
    )
      return details;
    details.category = analysisPreview(snapshot.category, 60) || null;
    details.summary = analysisPreview(snapshot.summary, 240) || null;
    details.suggestedActions = actionLabels(snapshot.suggestedActions);
    details.resultAvailable = true;
  } else if (status === "failed" && typeof snapshot.error === "string") {
    details.error = analysisPreview(snapshot.error, 500) || null;
    details.resultAvailable = true;
  }
  return details;
}
