import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import {
  DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
  mailAnalysisInstructionLines,
} from "../../../shared/mailAnalysisInstructions.js";
import { recordAudit, withAuditContext } from "../audit.js";
import { broadcastToCompany } from "../realtime.js";
import { workBlocked } from "../standdowns.js";
import { performThreadAction, type ThreadAction } from "./actions.js";
import { analysisPreview } from "./analysisEvidence.js";
import type { Mailbox } from "./mailbox/types.js";
import { isInboundReviewMessage } from "./reviewStatus.js";
import { columnHasLabel } from "./store.js";
import { unsubscribeFromMessage, type MailUnsubscribeResult } from "./unsubscribe.js";

/**
 * The mailbox's written instructions, carried out on newly-arrived mail.
 *
 * A Member writes, in plain language, what should happen to their mail —
 * "Unsubscribe me automatically from marketing emails." The AI Employee that
 * reads each arriving email (`analysis.ts`) decides which instruction, if any,
 * applies, and proposes the step. This file is everything that happens after
 * that proposal, and it is where the trust boundary sits:
 *
 *  1. **A fixed, server-owned list of steps.** Star, mark read, archive, add a
 *     label the instruction names, and unsubscribe through a verified RFC 8058
 *     one-click endpoint. Nothing that writes, sends, replies, forwards,
 *     deletes, files spam, spends money or starts other work can be reached
 *     from here, whatever the instruction or the model says.
 *  2. **The email never picks a target.** Every step acts on the one thread
 *     the server read, by the ids the server wrote. A label must be words the
 *     owner's instruction contains. An unsubscribe goes only to the endpoint
 *     the receiving server signed for, checked again as it is used.
 *  3. **Every step is attributable and visible.** Each one records the
 *     instruction it followed, the reader's reason, and its outcome on the
 *     analysis row the thread shows; applied and failed steps also write the
 *     audit log as the reading employee. Reversible steps can be undone by any
 *     Member from the email.
 *  4. **It runs once, on arrival.** Only the inbound queue calls
 *     {@link applyAutomaticAnalysisActions}, so a step never runs on imported
 *     history, a draft, mail the mailbox sent, or a person's "read again".
 *     It re-checks the mailbox's live state first: analysis still on, the
 *     instruction still written, no Standdown over the reader, and the
 *     reader's own Draft Grant — the same level an employee needs to triage
 *     mail through its tools.
 */

/** The only steps an instruction can trigger on its own. */
export const MAIL_ANALYSIS_AUTOMATIC_KINDS = [
  "star",
  "markRead",
  "archive",
  "applyLabel",
  "unsubscribe",
] as const;

export type MailAnalysisAutoKind = (typeof MAIL_ANALYSIS_AUTOMATIC_KINDS)[number];

/** At most this many steps per email; a sixth is a model under pressure. */
export const MAIL_ANALYSIS_MAX_AUTOMATIC_ACTIONS = 5;
export const MAIL_ANALYSIS_AUTO_REASON_CHARS = 200;
export const MAIL_ANALYSIS_AUTO_LABEL_CHARS = 100;

/**
 * A step still marked pending or running this long after the read finished
 * never ran to completion: the only code path that runs them does so straight
 * after the read. Shown as interrupted rather than as forever in progress.
 */
export const MAIL_ANALYSIS_AUTO_STALE_MS = 10 * 60 * 1_000;

export type MailAnalysisAutoStatus =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "failed"
  | "undone";

const STATUSES: readonly MailAnalysisAutoStatus[] = [
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
  "undone",
];

/**
 * One step an instruction asked for. `instruction` is the owner's own line,
 * resolved by the server from the number the model cited; `reason` is the
 * reader's words; `detail` is always the server's.
 */
export type MailAnalysisAutoAction = {
  id: string;
  /** `other` records a step the model asked for that is not on the list. */
  action: MailAnalysisAutoKind | "other";
  labelName?: string;
  instruction: string;
  reason: string;
  status: MailAnalysisAutoStatus;
  /** Why it was skipped or failed, or the host an unsubscribe reached. */
  detail?: string;
  targetHost?: string;
  appliedAt?: string;
  undoneAt?: string;
};

/** What the model submitted, before the server has checked any of it. */
export type MailAnalysisAutoProposal = {
  instruction: number;
  action: string;
  labelName?: string;
  reason: string;
};

/** A step that already touched the mailbox, or tried to. Its record is history. */
export function autoActionSettled(action: Pick<MailAnalysisAutoAction, "status">): boolean {
  return action.status !== "pending" && action.status !== "skipped";
}

// ───────────────────────────── instructions ─────────────────────────────

/** The text the mailbox follows: its own, or the default when it has none. */
export function effectiveAnalysisInstructions(
  account: Pick<MailAccount, "aiAnalysisInstructions">,
): string {
  return account.aiAnalysisInstructions ?? DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS;
}

/** The numbered list the model is shown and cites by number. */
export function analysisInstructionLines(
  account: Pick<MailAccount, "aiAnalysisInstructions">,
): string[] {
  return mailAnalysisInstructionLines(effectiveAnalysisInstructions(account));
}

// ───────────────────────────── persistence ─────────────────────────────

export function parseAutoActions(raw: string | null | undefined): MailAnalysisAutoAction[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const kinds = new Set<string>([...MAIL_ANALYSIS_AUTOMATIC_KINDS, "other"]);
  return parsed.flatMap((item): MailAnalysisAutoAction[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.action !== "string" ||
      !kinds.has(row.action) ||
      typeof row.status !== "string" ||
      !STATUSES.includes(row.status as MailAnalysisAutoStatus)
    )
      return [];
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    const entry: MailAnalysisAutoAction = {
      id: row.id,
      action: row.action as MailAnalysisAutoAction["action"],
      instruction: text(row.instruction) ?? "",
      reason: text(row.reason) ?? "",
      status: row.status as MailAnalysisAutoStatus,
    };
    for (const key of ["labelName", "detail", "targetHost", "appliedAt", "undoneAt"] as const) {
      const value = text(row[key]);
      if (value !== undefined) entry[key] = value;
    }
    return [entry];
  });
}

/**
 * What a reader is shown. A step left pending or running long after its read
 * finished belongs to a process that stopped; it will never run, so it is
 * reported as such instead of spinning forever.
 */
export function presentAutoActions(
  actions: MailAnalysisAutoAction[],
  finishedAt: Date | null,
  now: Date = new Date(),
): MailAnalysisAutoAction[] {
  const stale =
    !finishedAt || now.getTime() - finishedAt.getTime() > MAIL_ANALYSIS_AUTO_STALE_MS;
  if (!stale) return actions;
  return actions.map((action) => {
    if (action.status === "pending") {
      return { ...action, status: "skipped", detail: "Genosyn stopped before this could run." };
    }
    if (action.status === "running") {
      return {
        ...action,
        status: "failed",
        detail: "Genosyn stopped while this was running. Check the email to see where it got to.",
      };
    }
    return action;
  });
}

// ───────────────────────────── verification ─────────────────────────────

/**
 * Names the mailbox itself owns. Applying one by name would trash, spam or
 * un-archive a conversation under the guise of "adding a label", so none of
 * them may be reached by `applyLabel`, whatever an instruction says.
 */
const SYSTEM_LABEL_NAMES = new Set([
  "inbox",
  "unread",
  "starred",
  "important",
  "sent",
  "sent mail",
  "sent items",
  "draft",
  "drafts",
  "trash",
  "bin",
  "deleted",
  "deleted items",
  "spam",
  "junk",
  "junk email",
  "chat",
  "archive",
  "all mail",
]);

export function isSystemLabelName(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/^\[gmail\]\//, "");
  return SYSTEM_LABEL_NAMES.has(normalized) || normalized.startsWith("category_");
}

/** Whether `phrase` appears in `text` as whole words, ignoring case. */
export function namedInInstruction(text: string, phrase: string): boolean {
  const needle = phrase.trim();
  if (!/[\p{L}\p{N}]/u.test(needle)) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** A label as the model wrote it, without the quotes it tends to copy from the instruction. */
function cleanLabelName(value: string): string {
  return value
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .trim()
    .slice(0, MAIL_ANALYSIS_AUTO_LABEL_CHARS);
}

function boundedReason(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > MAIL_ANALYSIS_AUTO_REASON_CHARS
    ? `${text.slice(0, MAIL_ANALYSIS_AUTO_REASON_CHARS - 1)}…`
    : text;
}

function autoKind(value: string): MailAnalysisAutoAction["action"] {
  return (MAIL_ANALYSIS_AUTOMATIC_KINDS as readonly string[]).includes(value)
    ? (value as MailAnalysisAutoKind)
    : "other";
}

export type AutomaticVerificationContext = {
  /** The numbered instructions the model was shown, in order. */
  instructions: string[];
  unsubscribeAvailable: boolean;
  unsubscribeHost: string;
  provider: MailAccount["provider"];
  /** The category the same read gave the email. */
  category: string;
};

/**
 * Hold every proposed step to what the server will stand behind.
 *
 * A step that fails a check is kept, marked skipped with the server's reason,
 * so the person reading the email learns why their instruction did not happen
 * — "this email has no verified unsubscribe link" — instead of wondering. A
 * repeat of the same step is dropped silently. Nothing here touches the
 * mailbox; it only decides what may.
 */
export function verifyAutomaticActions(
  proposals: MailAnalysisAutoProposal[],
  context: AutomaticVerificationContext,
): MailAnalysisAutoAction[] {
  const verified: MailAnalysisAutoAction[] = [];
  const seen = new Set<string>();
  for (const [index, proposal] of proposals.slice(0, MAIL_ANALYSIS_MAX_AUTOMATIC_ACTIONS).entries()) {
    const action = autoKind(proposal.action.trim());
    const labelName = action === "applyLabel" ? cleanLabelName(proposal.labelName ?? "") : "";
    const key = `${action}:${action === "other" ? index : labelName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const instruction =
      Number.isInteger(proposal.instruction) && proposal.instruction >= 1
        ? (context.instructions[proposal.instruction - 1] ?? "")
        : "";
    const base = {
      id: `auto-${index}`,
      action,
      ...(labelName ? { labelName } : {}),
      instruction,
      reason: boundedReason(proposal.reason),
    };
    const skip = (detail: string) =>
      verified.push({ ...base, status: "skipped", detail });

    if (!instruction) {
      skip("It did not match one of this mailbox's instructions.");
      continue;
    }
    switch (action) {
      case "other":
        skip(
          "Genosyn only stars, marks read, archives, labels or unsubscribes on its own. It never replies, sends, forwards or deletes.",
        );
        break;
      case "star":
      case "markRead":
      case "archive":
        verified.push({ ...base, status: "pending" });
        break;
      case "applyLabel":
        if (!labelName) skip("No label was named.");
        else if (isSystemLabelName(labelName))
          skip("Inbox, Spam, Trash and other system folders can't be applied automatically.");
        else if (!namedInInstruction(instruction, labelName))
          skip(`Only a label your instruction names can be added, and it doesn't name “${labelName}”.`);
        else verified.push({ ...base, status: "pending" });
        break;
      case "unsubscribe":
        if (context.category === "spam") {
          skip(
            "This looks like spam. Unsubscribing would tell the sender your address is real, so it is better moved to Spam.",
          );
        } else if (!context.unsubscribeAvailable) {
          skip(
            context.provider === "gmail"
              ? "This email has no verified one-click unsubscribe, so Genosyn will not follow a link from it."
              : "Automatic unsubscribe needs a Gmail mailbox, where Genosyn can check the sender's signature.",
          );
        } else {
          verified.push({ ...base, status: "pending", targetHost: context.unsubscribeHost });
        }
        break;
    }
  }
  return verified;
}

// ───────────────────────────── running the steps ─────────────────────────────

/** The inbound queue's own checks: still runnable, and effects are starting. */
export type MailAutomaticActionFences = {
  assertRunnable: () => Promise<void>;
  beforeEffect: () => Promise<void>;
};

const NO_FENCES: MailAutomaticActionFences = {
  assertRunnable: async () => {},
  beforeEffect: async () => {},
};

/** The outside world, swappable in tests. Production omits it. */
export type MailAutomaticActionDependencies = {
  mailbox?: (account: MailAccount) => Promise<Mailbox>;
  unsubscribe?: (account: MailAccount, message: MailMessage) => Promise<MailUnsubscribeResult>;
  now?: () => Date;
};

export class MailAutomaticActionError extends Error {}

const ARRIVAL_ONLY = "Only newly arrived email is acted on automatically.";
const STOPPED = "The mailbox was paused or disconnected before this ran.";

type GateResult =
  | { ok: false; detail: string | null }
  | {
      ok: true;
      account: MailAccount;
      message: MailMessage;
      thread: MailThread;
      employee: AIEmployee;
      lines: string[];
    };

/**
 * Everything that has to hold, right now, before any step runs. The read
 * happened up to a couple of minutes ago, and a Member can turn analysis off,
 * rewrite the instructions, stand the employee down or lower its Grant in that
 * time — the step must answer to the mailbox as it is, not as it was.
 */
async function automaticActionGate(
  account: MailAccount,
  message: MailMessage,
  analysis: MailInboundAnalysis,
): Promise<GateResult> {
  const live = await AppDataSource.getRepository(MailAccount).findOneBy({
    id: account.id,
    companyId: account.companyId,
  });
  // A disconnected mailbox takes its analyses with it; there is nothing to mark.
  if (!live) return { ok: false, detail: null };
  if (live.status === "paused") return { ok: false, detail: STOPPED };
  if (!live.aiAnalysisEnabled) {
    return { ok: false, detail: "AI analysis was turned off before this ran." };
  }
  const lines = analysisInstructionLines(live);
  if (lines.length === 0) {
    return { ok: false, detail: "The mailbox's instructions were cleared before this ran." };
  }
  const employee = analysis.employeeId
    ? await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: analysis.employeeId,
        companyId: live.companyId,
      })
    : null;
  if (!employee) {
    return { ok: false, detail: "The AI Employee that read this email is no longer here." };
  }
  const stop = workBlocked(live.companyId, { employeeId: employee.id });
  if (stop.blocked) {
    return { ok: false, detail: `AI work is stood down: ${analysisPreview(stop.reason, 200)}` };
  }
  const grant = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
    employeeId: employee.id,
    accountId: live.id,
  });
  if (!grant || MAIL_ACCESS_RANK[grant.accessLevel] < MAIL_ACCESS_RANK.draft) {
    return {
      ok: false,
      detail: `${employee.name} needs Draft access to this mailbox to act on its own. Raise it under AI access.`,
    };
  }
  const current = await AppDataSource.getRepository(MailMessage).findOneBy({
    id: message.id,
    accountId: live.id,
    companyId: live.companyId,
  });
  if (!current || current.threadId !== analysis.threadId || !isInboundReviewMessage(current, live)) {
    return { ok: false, detail: ARRIVAL_ONLY };
  }
  if (columnHasLabel(current.labelIds, "SPAM") || columnHasLabel(current.labelIds, "TRASH")) {
    return { ok: false, detail: "This email is in Spam or Trash." };
  }
  // The outbox row is the server's own proof this was a genuine arrival: the
  // sync engines write it only for new mail, never for imported history, a
  // draft, or a message the mailbox sent. Looked up by its unique key.
  const arrival = await AppDataSource.getRepository(MailInboundAutomation).findOneBy({
    accountId: live.id,
    gmailMessageId: current.gmailMessageId,
  });
  if (!arrival || arrival.messageId !== current.id) return { ok: false, detail: ARRIVAL_ONLY };
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: analysis.threadId,
    accountId: live.id,
    companyId: live.companyId,
  });
  if (!thread) return { ok: false, detail: "This email's conversation is gone." };
  return { ok: true, account: live, message: current, thread, employee, lines };
}

/**
 * Rewrite the steps by compare-and-swap on the whole blob, so two writers —
 * the queue applying steps, a Member undoing one — can never clobber each
 * other's stamps. `change` returns null to leave the row as it is.
 */
async function transitionAutoActions(
  analysisId: string,
  change: (actions: MailAnalysisAutoAction[]) => MailAnalysisAutoAction[] | null,
): Promise<{ actions: MailAnalysisAutoAction[]; previousJson: string; json: string } | null> {
  const repo = AppDataSource.getRepository(MailInboundAnalysis);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const fresh = await repo.findOneBy({ id: analysisId });
    if (!fresh) return null;
    const next = change(parseAutoActions(fresh.autoActionsJson));
    if (!next) return null;
    const json = JSON.stringify(next);
    const result = await repo
      .createQueryBuilder()
      .update()
      .set({ autoActionsJson: json })
      .where("id = :id", { id: analysisId })
      .andWhere('"autoActionsJson" = :previous', { previous: fresh.autoActionsJson })
      .execute();
    if ((result.affected ?? 0) > 0) {
      return { actions: next, previousJson: fresh.autoActionsJson, json };
    }
  }
  return null;
}

function replace(
  actions: MailAnalysisAutoAction[],
  id: string,
  expected: MailAnalysisAutoStatus,
  update: (action: MailAnalysisAutoAction) => MailAnalysisAutoAction,
): MailAnalysisAutoAction[] | null {
  const target = actions.find((action) => action.id === id);
  if (!target || target.status !== expected) return null;
  return actions.map((action) => (action.id === id ? update(action) : action));
}

async function skipPending(analysisId: string, detail: string): Promise<void> {
  await transitionAutoActions(analysisId, (actions) =>
    actions.some((action) => action.status === "pending")
      ? actions.map((action) =>
          action.status === "pending" ? { ...action, status: "skipped" as const, detail } : action,
        )
      : null,
  );
}

function errorText(error: unknown): string {
  return analysisPreview(error instanceof Error ? error.message : String(error), 300) ||
    "The mail server refused the change.";
}

function auditMetadata(
  analysis: MailInboundAnalysis,
  action: MailAnalysisAutoAction,
): Record<string, unknown> {
  return {
    messageId: analysis.messageId,
    accountId: analysis.accountId,
    autoActionId: action.id,
    action: action.action,
    ...(action.labelName ? { labelName: analysisPreview(action.labelName, 100) } : {}),
    instruction: analysisPreview(action.instruction, 300),
    reason: analysisPreview(action.reason, MAIL_ANALYSIS_AUTO_REASON_CHARS),
  };
}

const THREAD_ACTIONS: Record<Exclude<MailAnalysisAutoKind, "unsubscribe">, ThreadAction> = {
  star: "star",
  markRead: "markRead",
  archive: "archive",
  applyLabel: "applyLabel",
};

/**
 * Carry out the pending steps the arrival read recorded for one email.
 *
 * Called by the inbound queue straight after the read, with its fences: a
 * pause or a lost lease stops the remaining steps, which are marked skipped
 * before the queue's own error carries on. A step that fails on its own — a
 * label the server refuses, an unsubscribe endpoint that answers 500 — is
 * recorded as failed and the rest still run, the way one broken rule action
 * never stops the next.
 *
 * Idempotent: only `pending` steps run, and each is claimed before its effect,
 * so a replay or a second caller finds nothing left to do.
 */
export async function applyAutomaticAnalysisActions(
  account: MailAccount,
  message: MailMessage,
  analysisId: string,
  fences: MailAutomaticActionFences = NO_FENCES,
  dependencies: MailAutomaticActionDependencies = {},
): Promise<MailAnalysisAutoAction[]> {
  const repo = AppDataSource.getRepository(MailInboundAnalysis);
  const analysis = await repo.findOneBy({
    id: analysisId,
    companyId: account.companyId,
    accountId: account.id,
  });
  if (
    !analysis ||
    analysis.messageId !== message.id ||
    message.accountId !== account.id ||
    message.companyId !== account.companyId
  ) {
    throw new MailAutomaticActionError("These automatic actions do not belong to this email.");
  }
  if (analysis.status !== "succeeded") return parseAutoActions(analysis.autoActionsJson);
  if (!parseAutoActions(analysis.autoActionsJson).some((action) => action.status === "pending")) {
    return parseAutoActions(analysis.autoActionsJson);
  }

  try {
    await fences.assertRunnable();
  } catch (error) {
    await skipPending(analysis.id, STOPPED);
    throw error;
  }

  const gate = await automaticActionGate(account, message, analysis);
  if (!gate.ok) {
    if (gate.detail) {
      await skipPending(analysis.id, gate.detail);
      broadcastToCompany(account.companyId, { type: "mail.updated", accountId: account.id });
    }
    return parseAutoActions((await repo.findOneBy({ id: analysis.id }))?.autoActionsJson);
  }

  const now = dependencies.now ?? (() => new Date());
  const pending = parseAutoActions(analysis.autoActionsJson).filter(
    (action) => action.status === "pending",
  );
  let changed = false;
  for (const step of pending) {
    if (!gate.lines.includes(step.instruction)) {
      changed =
        Boolean(
          await transitionAutoActions(analysis.id, (actions) =>
            replace(actions, step.id, "pending", (action) => ({
              ...action,
              status: "skipped",
              detail: "Your instructions changed before this ran.",
            })),
          ),
        ) || changed;
      continue;
    }
    // A Standdown placed while an earlier step ran stops the rest of them.
    const stop = workBlocked(gate.account.companyId, { employeeId: gate.employee.id });
    if (stop.blocked) {
      await skipPending(analysis.id, `AI work is stood down: ${analysisPreview(stop.reason, 200)}`);
      changed = true;
      break;
    }
    try {
      await fences.beforeEffect();
    } catch (error) {
      await skipPending(analysis.id, STOPPED);
      broadcastToCompany(account.companyId, { type: "mail.updated", accountId: account.id });
      throw error;
    }
    const claimed = await transitionAutoActions(analysis.id, (actions) =>
      replace(actions, step.id, "pending", (action) => ({ ...action, status: "running" })),
    );
    if (!claimed) continue;
    changed = true;
    try {
      const outcome = await withAuditContext({ mailThreadId: gate.thread.id }, () =>
        runStep(gate, step, dependencies),
      );
      const done = await transitionAutoActions(analysis.id, (actions) =>
        replace(actions, step.id, "running", (action) => ({
          ...action,
          status: "done",
          appliedAt: now().toISOString(),
          ...(outcome.host ? { targetHost: outcome.host, detail: `via ${outcome.host}` } : {}),
        })),
      );
      const recorded = done?.actions.find((action) => action.id === step.id) ?? step;
      await withAuditContext({ mailThreadId: gate.thread.id }, () =>
        recordAudit({
          companyId: gate.account.companyId,
          actorEmployeeId: gate.employee.id,
          action: "mail.analysis.automatic",
          targetType: "mail_inbound_analysis",
          targetId: analysis.id,
          targetLabel: gate.thread.subject || "(no subject)",
          metadata: {
            ...auditMetadata(analysis, recorded),
            ...(outcome.host ? { endpointHost: outcome.host, endpointStatus: outcome.status } : {}),
          },
        }),
      );
    } catch (error) {
      const detail = errorText(error);
      await transitionAutoActions(analysis.id, (actions) =>
        replace(actions, step.id, "running", (action) => ({ ...action, status: "failed", detail })),
      );
      // eslint-disable-next-line no-console
      console.error(`[mail] automatic ${step.action} on analysis ${analysis.id} failed:`, error);
      await withAuditContext({ mailThreadId: gate.thread.id }, () =>
        recordAudit({
          companyId: gate.account.companyId,
          actorEmployeeId: gate.employee.id,
          action: "mail.analysis.automatic_failed",
          targetType: "mail_inbound_analysis",
          targetId: analysis.id,
          targetLabel: gate.thread.subject || "(no subject)",
          metadata: { ...auditMetadata(analysis, step), error: detail },
        }),
      );
    }
  }
  if (changed) {
    broadcastToCompany(account.companyId, { type: "mail.updated", accountId: account.id });
  }
  return parseAutoActions((await repo.findOneBy({ id: analysis.id }))?.autoActionsJson);
}

async function runStep(
  gate: Extract<GateResult, { ok: true }>,
  step: MailAnalysisAutoAction,
  dependencies: MailAutomaticActionDependencies,
): Promise<{ host?: string; status?: number }> {
  switch (step.action) {
    case "unsubscribe": {
      // The endpoint is re-resolved and re-verified from the message's own
      // signed headers here, not taken from the read: the same checks as the
      // button, at the moment the request is made.
      const result = await (dependencies.unsubscribe ?? unsubscribeFromMessage)(
        gate.account,
        gate.message,
      );
      return { host: result.host, status: result.status };
    }
    case "applyLabel": {
      const name = (step.labelName ?? "").trim();
      if (!name || isSystemLabelName(name)) {
        throw new MailAutomaticActionError("System folders can't be applied automatically.");
      }
      const labels = await AppDataSource.getRepository(MailLabel).find({
        where: { accountId: gate.account.id },
      });
      if (
        labels.some(
          (label) => label.labelType === "system" && label.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        throw new MailAutomaticActionError("System folders can't be applied automatically.");
      }
      await performThreadAction(
        gate.account,
        gate.thread,
        "applyLabel",
        { labelName: name, silent: true },
        threadDependencies(dependencies),
      );
      return {};
    }
    case "star":
    case "markRead":
    case "archive":
      await performThreadAction(
        gate.account,
        gate.thread,
        THREAD_ACTIONS[step.action],
        { silent: true },
        threadDependencies(dependencies),
      );
      return {};
    default:
      throw new MailAutomaticActionError("That step is not something Genosyn does on its own.");
  }
}

function threadDependencies(dependencies: MailAutomaticActionDependencies) {
  return dependencies.mailbox ? { mailbox: dependencies.mailbox, notify: () => {} } : {};
}

// ───────────────────────────── undo ─────────────────────────────

const UNDO: Record<Exclude<MailAnalysisAutoKind, "unsubscribe">, ThreadAction> = {
  star: "unstar",
  markRead: "markUnread",
  archive: "moveToInbox",
  applyLabel: "removeLabel",
};

/** Whether a Member can take this step back from the email. */
export function autoActionUndoable(action: MailAnalysisAutoAction): boolean {
  return action.status === "done" && action.action !== "unsubscribe" && action.action !== "other";
}

/**
 * Take one automatic step back, with the pressing Member's authority.
 *
 * The step is stamped undone before the mailbox is touched, the same claim
 * order the one-click buttons use, so a double-click cannot reverse it twice;
 * a failed reversal puts the stamp back so the Member can try again.
 */
export async function undoAutomaticAnalysisAction(
  account: MailAccount,
  analysis: MailInboundAnalysis,
  autoActionId: string,
  actor: { userId: string },
  dependencies: MailAutomaticActionDependencies = {},
): Promise<{ analysis: MailInboundAnalysis; message: string }> {
  if (analysis.accountId !== account.id || analysis.companyId !== account.companyId) {
    throw new MailAutomaticActionError("This email does not belong to this mailbox.");
  }
  const current = parseAutoActions(analysis.autoActionsJson).find(
    (action) => action.id === autoActionId,
  );
  if (!current) throw new MailAutomaticActionError("That automatic action is not on this email.");
  if (current.status === "undone") throw new MailAutomaticActionError("That was already undone.");
  if (current.action === "unsubscribe" && current.status === "done") {
    throw new MailAutomaticActionError(
      "An unsubscribe can't be undone from Genosyn. Subscribe again on the sender's site if you want this mail back.",
    );
  }
  if (!autoActionUndoable(current)) {
    throw new MailAutomaticActionError("Only a step that was carried out can be undone.");
  }
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: analysis.threadId,
    accountId: account.id,
    companyId: account.companyId,
  });
  if (!thread) throw new MailAutomaticActionError("This email's conversation is gone.");

  const now = dependencies.now ?? (() => new Date());
  const claim = await transitionAutoActions(analysis.id, (actions) =>
    replace(actions, autoActionId, "done", (action) => ({
      ...action,
      status: "undone",
      undoneAt: now().toISOString(),
    })),
  );
  if (!claim) {
    throw new MailAutomaticActionError(
      "That automatic action changed while you were looking. Reload the email and try again.",
    );
  }
  const kind = current.action as Exclude<MailAnalysisAutoKind, "unsubscribe">;
  try {
    await performThreadAction(
      account,
      thread,
      UNDO[kind],
      kind === "applyLabel" ? { labelName: current.labelName } : {},
      dependencies.mailbox ? { mailbox: dependencies.mailbox } : {},
    );
  } catch (error) {
    // Only this claim's own write is reverted; a later stamp is left alone.
    await AppDataSource.getRepository(MailInboundAnalysis)
      .createQueryBuilder()
      .update()
      .set({ autoActionsJson: claim.previousJson })
      .where("id = :id", { id: analysis.id })
      .andWhere('"autoActionsJson" = :claimed', { claimed: claim.json })
      .execute();
    throw error;
  }
  await withAuditContext({ mailThreadId: thread.id }, () =>
    recordAudit({
      companyId: account.companyId,
      actorUserId: actor.userId,
      action: "mail.analysis.automatic_undo",
      targetType: "mail_inbound_analysis",
      targetId: analysis.id,
      targetLabel: thread.subject || "(no subject)",
      metadata: auditMetadata(analysis, current),
    }),
  );
  const fresh = await AppDataSource.getRepository(MailInboundAnalysis).findOneByOrFail({
    id: analysis.id,
  });
  return { analysis: fresh, message: UNDO_MESSAGES[kind] };
}

const UNDO_MESSAGES: Record<Exclude<MailAnalysisAutoKind, "unsubscribe">, string> = {
  star: "Unstarred",
  markRead: "Marked unread",
  archive: "Moved back to the inbox",
  applyLabel: "Label removed",
};

// ───────────────────────────── cross-automation guard ─────────────────────────────

/**
 * Whether the mailbox's instructions already unsubscribed from this exact
 * message. An unsubscribe request is irreversible and tells the sender the
 * address is live, so a Rule that would send the same request a second time
 * stands down instead. Reads the analysis by its unique message index.
 */
export async function unsubscribedByInstructions(messageId: string): Promise<boolean> {
  const analysis = await AppDataSource.getRepository(MailInboundAnalysis).findOne({
    where: { messageId },
    select: ["id", "autoActionsJson"],
  });
  if (!analysis) return false;
  return parseAutoActions(analysis.autoActionsJson).some(
    (action) =>
      action.action === "unsubscribe" && (action.status === "done" || action.status === "running"),
  );
}
