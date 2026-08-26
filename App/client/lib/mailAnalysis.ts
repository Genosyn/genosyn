import { formatMoney, type FinanceAccess } from "./api";
import { MAIL_ANALYSIS_FINANCE_KINDS } from "./mail";
import type { MailAccessLevel, MailAnalysisAction, MailAssistantRosterEntry } from "./mail";

/**
 * Presentation rules for AI triage of inbound mail.
 *
 * Pure functions on purpose: the mail pages have no component tests, so the
 * decisions worth pinning — what a button warns about before it runs, what
 * the Member reads under a model-authored label, who is eligible to do the
 * reading — live here and are covered directly.
 */

/** Human name for a category chip. Unknown values fall back to the raw slug. */
const CATEGORY_LABELS: Record<string, string> = {
  invoice_request: "Invoice request",
  quote_request: "Quote request",
  payment: "Payment",
  customer_support: "Support",
  sales_lead: "Sales lead",
  scheduling: "Scheduling",
  vendor: "Vendor",
  recruiting: "Recruiting",
  marketing: "Marketing",
  notification: "Notification",
  internal: "Internal",
  personal: "Personal",
  spam: "Spam",
  other: "Other",
};

/**
 * Chip colours. Money-shaped categories are emerald so an invoice or a quote
 * catches the eye scanning a thread; noise is slate so it does not.
 */
const CATEGORY_TONES: Record<string, string> = {
  invoice_request: "emerald",
  quote_request: "emerald",
  payment: "emerald",
  customer_support: "indigo",
  sales_lead: "violet",
  scheduling: "sky",
  vendor: "amber",
  recruiting: "sky",
  marketing: "slate",
  notification: "slate",
  internal: "slate",
  personal: "slate",
  spam: "red",
};

const HANDOVER_MODE_LABELS: Record<string, string> = {
  draft: "drafts a reply",
  reply: "replies for you",
  triage: "triages it",
};

export function analysisCategoryLabel(category: string): string {
  if (!category) return "";
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, " ");
}

export function analysisCategoryTone(category: string): string {
  return CATEGORY_TONES[category] ?? "slate";
}

export const CATEGORY_TONE_CLASSES: Record<string, string> = {
  emerald:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
  indigo:
    "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300",
  violet:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
  sky: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300",
  amber:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
  red: "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
  slate:
    "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
};

/**
 * The server-checked line shown under a model-authored label.
 *
 * This is the whole point of the `target*` fields: a button that says
 * "Unsubscribe" tells the Member which host it will talk to, and one that says
 * "Create the invoice" tells them what it adds up to — neither taken from the
 * label, which the model wrote.
 */
export function analysisActionDetail(action: MailAnalysisAction): string | null {
  switch (action.kind) {
    case "draft_reply":
      return action.targetTo ? `Reply to ${action.targetTo}` : null;
    case "unsubscribe":
      return action.targetHost ? `via ${action.targetHost}` : null;
    case "hand_over": {
      if (!action.targetEmployeeName) return null;
      // The mode is the whole risk: "triage" files the thread, "reply" answers
      // it on the company's behalf. A verified line that names only the
      // employee hides the half a Member is actually approving.
      return action.mode
        ? `${action.targetEmployeeName} · ${HANDOVER_MODE_LABELS[action.mode] ?? action.mode}`
        : action.targetEmployeeName;
    }
    case "create_invoice":
    case "create_estimate": {
      if (action.targetTotalCents === undefined) return action.customerName ?? null;
      const money = formatMoney(action.targetTotalCents, action.currency || "USD");
      return action.customerName ? `${action.customerName} · ${money}` : money;
    }
    case "thread_action":
      return action.action === "applyLabel" && action.labelName ? action.labelName : null;
    default:
      return null;
  }
}

/** Hover copy that says plainly what pressing this will do. */
export function analysisActionHint(action: MailAnalysisAction): string {
  switch (action.kind) {
    case "draft_reply":
      return "Saves a Gmail draft for you to review — nothing sends until you send it";
    case "create_invoice":
      return "Creates a draft invoice — no number, no ledger entry, nothing emailed";
    case "create_estimate":
      return "Creates a draft estimate — nothing is sent to the customer";
    case "unsubscribe":
      return "Sends the sender's verified one-click unsubscribe request";
    case "thread_action":
      return "Applies the triage action to this thread";
    case "hand_over":
      return "Hands this thread to an AI employee to work";
    default:
      // Never the model's own label: this string is the safety explanation, so
      // a kind added server-side without touching this file must read as
      // unknown rather than as whatever the email talked the model into.
      return "Runs this action";
  }
}

/**
 * Why this Member cannot press this button, if they cannot.
 *
 * `create_invoice` and `create_estimate` write real finance rows, so the
 * server refuses them for anyone below `full` finance access — the same bar
 * the finance routes themselves hold. The model proposes buttons from the
 * email alone and has no idea who is reading, so the check has to happen
 * here too: an affordance that only fails once you commit to it is the
 * confusing turn a grayed-out entry exists to prevent.
 *
 * Returns null when the button is fine, or the sentence to show instead.
 */
export function analysisActionBlockedReason(
  action: MailAnalysisAction,
  financeAccess: FinanceAccess,
): string | null {
  if (!(MAIL_ANALYSIS_FINANCE_KINDS as readonly string[]).includes(action.kind)) return null;
  if (financeAccess === "full") return null;
  return financeAccess === "none"
    ? "You don\u2019t have access to this company\u2019s finances"
    : "You have read-only finance access";
}

/**
 * Which buttons stop and ask first.
 *
 * Unsubscribing tells a sender the address is live, and both money documents
 * create real rows a human then has to clean up. Everything else here is
 * either reversible in a click or lands in a review queue anyway.
 */
export function analysisActionConfirm(
  action: MailAnalysisAction,
): { title: string; message: string; confirmLabel: string } | null {
  switch (action.kind) {
    case "unsubscribe":
      return {
        title: "Unsubscribe from this sender?",
        message: `Genosyn will send the one-click unsubscribe request${
          action.targetHost ? ` to ${action.targetHost}` : ""
        }. This confirms your address is real to that sender.`,
        confirmLabel: "Unsubscribe",
      };
    case "create_invoice":
      return {
        title: "Create a draft invoice?",
        message: `${analysisActionDetail(action) ?? "A draft invoice"} — it gets no number and posts nothing to the ledger until you issue it.`,
        confirmLabel: "Create draft",
      };
    case "create_estimate":
      return {
        title: "Create a draft estimate?",
        message: `${analysisActionDetail(action) ?? "A draft estimate"} — nothing is sent to the customer until you send it.`,
        confirmLabel: "Create draft",
      };
    case "hand_over":
      // The instruction was written by an employee reading an untrusted email,
      // and it becomes the brief for a turn with that employee's full tools.
      // It is the part worth reading, so it is the part shown — a label alone
      // would have the Member approving a sentence they never saw.
      return {
        title: `Hand this thread to ${action.targetEmployeeName ?? "an AI employee"}?`,
        message: `They will ${
          action.mode ? (HANDOVER_MODE_LABELS[action.mode] ?? action.mode) : "work the thread"
        }, working from this instruction:\n\n${action.instruction ?? "(no instruction)"}`,
        confirmLabel: "Hand over",
      };
    default:
      return null;
  }
}

export type AnalysisEmployeeOption = {
  entry: MailAssistantRosterEntry;
  eligible: boolean;
  detail: string;
};

/**
 * Who may be chosen to read this mailbox's inbound mail.
 *
 * An employee needs both a grant on the mailbox and a connected model; the
 * picker still lists everyone else, disabled and labelled with what they are
 * missing. A silently-absent option teaches nothing, and "why isn't Jamie in
 * the list" is a support question the detail line answers by itself.
 */
export function analysisEmployeeOptions(
  roster: MailAssistantRosterEntry[],
): AnalysisEmployeeOption[] {
  return roster.map((entry) => {
    const missing: string[] = [];
    if (!entry.accessLevel) missing.push("no mailbox access");
    if (entry.models.length === 0) missing.push("no connected model");
    return {
      entry,
      eligible: missing.length === 0,
      detail:
        missing.length > 0
          ? missing.join(" · ")
          : `${accessLabel(entry.accessLevel)} · ${entry.models.length} model${
              entry.models.length === 1 ? "" : "s"
            }`,
    };
  });
}

function accessLabel(level: MailAssistantRosterEntry["accessLevel"]): string {
  switch (level) {
    case "read":
      return "Read access";
    case "draft":
      return "Draft access";
    case "send":
      return "Send access";
    default:
      return "No access";
  }
}

/**
 * What the mailbox can actually do today, in one sentence for the settings
 * card. Reading is not the same as being able to offer the useful buttons:
 * an employee on Read can categorise mail but cannot propose a draft reply.
 */
export function analysisReadinessNote(args: {
  enabled: boolean;
  resolved: { employeeName: string; modelLabel: string; accessLevel: MailAccessLevel } | null;
}): { tone: "ok" | "warn" | "off"; text: string } {
  if (!args.enabled) {
    return { tone: "off", text: "New mail arrives without a summary or action buttons." };
  }
  if (!args.resolved) {
    return {
      tone: "warn",
      text: "No AI employee with a connected model has access to this mailbox yet, so nothing is being analysed. Grant one under AI access below.",
    };
  }
  const base = `${args.resolved.employeeName} reads new mail on ${args.resolved.modelLabel}.`;
  return args.resolved.accessLevel === "read"
    ? {
        tone: "warn",
        text: `${base} On Read access they can summarise and triage, but cannot offer to draft a reply — raise them to Draft for that.`,
      }
    : { tone: "ok", text: base };
}
