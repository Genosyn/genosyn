import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailThread } from "../../db/entities/MailThread.js";
import type { Sequence } from "../../db/entities/Sequence.js";
import type { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import type { SequenceStep } from "../../db/entities/SequenceStep.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { chatWithEmployee } from "../chat.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { listActivities } from "./activities.js";
import { hasRevenueAccess } from "./grants.js";
import {
  type TouchOutcome,
  setTouchDrafter,
  tickSequences,
} from "./sequenceTick.js";
import { setSignalHandler, tickSignals } from "./signalTick.js";

/**
 * Boot wiring for the Revenue section.
 *
 * Two things live here, and both exist to keep a dependency from pointing the
 * wrong way:
 *
 * 1. **The heartbeats.** `tickSequences` and `tickSignals` each take their own
 *    scheduler lease rather than sharing the routines lease, so a long routine
 *    dispatch cannot stall outbound mail and a slow customer database cannot
 *    stall routines. Each has its own guard against overlapping passes.
 * 2. **The real implementations of the two injectable seams.** `sequenceTick`
 *    and `signalTick` are written against callbacks precisely so that importing
 *    them does not drag the agent runtime — and therefore every model provider
 *    — into any test that touches a sequence. This module is the one place that
 *    knows about both halves, and it is imported only at boot.
 */

const HEARTBEAT_INTERVAL_MS = 60 * 1000;

let sequenceTimer: NodeJS.Timeout | null = null;
let signalTimer: NodeJS.Timeout | null = null;
let sequenceTicking = false;
let signalTicking = false;

/** How much of the contact's recent history to put in front of the employee. */
const TIMELINE_CONTEXT_ROWS = 12;
/** Cap on the reply we keep as the step-run detail. */
const DETAIL_CAP = 2_000;

/**
 * Ask the sequence's AI Employee to write one touch.
 *
 * Deliberately does **not** compose or send the mail itself. It hands the
 * employee the context and the instruction, and the employee uses its own
 * grant-gated mail tools to write the draft — which means the suppression
 * check, the mailbox capability check and the audit trail all happen on the
 * paths that already enforce them, rather than on a second path this module
 * would have to keep in sync.
 *
 * The outcome is therefore `drafted` on a clean run: the tick records that the
 * employee was asked and answered. Whether a message actually left is decided
 * by the mail layer and shows up in the drafts review queue.
 */
async function draftTouch(ctx: {
  sequence: Sequence;
  step: SequenceStep;
  enrollment: SequenceEnrollment;
  contact: Contact;
}): Promise<TouchOutcome> {
  const { sequence, step, enrollment, contact } = ctx;

  const [employee, account] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({ id: sequence.employeeId }),
    AppDataSource.getRepository(MailAccount).findOneBy({ id: sequence.mailAccountId }),
  ]);
  if (!employee) {
    return { status: "failed", detail: "The AI employee behind this sequence is gone." };
  }
  if (!account) {
    return { status: "failed", detail: "The mailbox behind this sequence is gone." };
  }

  // `autoSend` needs BOTH grants, re-checked here at send time rather than
  // trusted from whenever somebody ticked the box. A grant revoked yesterday
  // must take effect today.
  const mailGrant = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
    employeeId: employee.id,
    accountId: account.id,
  });
  const mayAutoSend =
    sequence.autoSend &&
    (await hasRevenueAccess(employee.id, "send")) &&
    !!mailGrant &&
    MAIL_ACCESS_RANK[mailGrant.accessLevel] >= MAIL_ACCESS_RANK.send;

  const prompt = await composeTouchPrompt({
    sequence,
    step,
    enrollment,
    contact,
    account,
    mayAutoSend,
  });

  const result = await chatWithEmployee(sequence.companyId, employee.id, prompt, []);
  const detail = result.reply.slice(0, DETAIL_CAP);
  if (result.status !== "ok") {
    return { status: "failed", detail };
  }
  return {
    status: mayAutoSend ? "sent" : "drafted",
    detail,
    subject: `${sequence.name} · step ${step.sortOrder + 1}`,
    mailThreadId: enrollment.mailThreadId ?? null,
  };
}

/** Everything the employee needs to write one genuinely personal email. */
async function composeTouchPrompt(input: {
  sequence: Sequence;
  step: SequenceStep;
  enrollment: SequenceEnrollment;
  contact: Contact;
  account: MailAccount;
  mayAutoSend: boolean;
}): Promise<string> {
  const { sequence, step, enrollment, contact, account, mayAutoSend } = input;

  const [timeline, deal, thread] = await Promise.all([
    listActivities(sequence.companyId, {
      contactId: contact.id,
      limit: TIMELINE_CONTEXT_ROWS,
    }),
    enrollment.dealId
      ? AppDataSource.getRepository(Deal).findOneBy({
          id: enrollment.dealId,
          companyId: sequence.companyId,
        })
      : Promise.resolve(null),
    enrollment.mailThreadId
      ? AppDataSource.getRepository(MailThread).findOneBy({
          id: enrollment.mailThreadId,
        })
      : Promise.resolve(null),
  ]);

  const history = timeline.rows
    .map((a) => {
      const when = a.occurredAt.toISOString().slice(0, 10);
      const body = a.bodyText ? ` — ${a.bodyText.slice(0, 300)}` : "";
      return `- ${when} · ${a.kind} · ${a.subject}${body}`;
    })
    .join("\n");

  const lines = [
    `You are writing step ${step.sortOrder + 1} of the "${sequence.name}" outbound sequence.`,
    "",
    "## Who you are writing to",
    `- Name: ${contact.name}`,
    `- Email: ${contact.email}`,
    contact.title ? `- Title: ${contact.title}` : "",
    contact.companyName ? `- Company: ${contact.companyName}` : "",
    contact.linkedinUrl ? `- LinkedIn: ${contact.linkedinUrl}` : "",
    "",
    "## The standing brief for this sequence",
    sequence.brief || "(none written — use your judgement and keep it short)",
    "",
    "## What this specific step should do",
    step.instruction || "(no step instruction — write a brief, useful follow-up)",
    "",
  ];

  if (deal) {
    lines.push(
      "## The open deal",
      `"${deal.title}" — ${(deal.amountCents / 100).toFixed(2)} ${deal.currency}, next step: ${deal.nextStep || "unset"}.`,
      "Your email should move this forward, not restate it.",
      "",
    );
  }

  lines.push(
    "## What you already know about them",
    history
      ? `${history}\n\nRead that before writing. Repeating an introduction they have already had is worse than not writing at all.`
      : "Nothing yet — this is the first contact.",
    "",
    "## How to send it",
    `Send from the mailbox ${account.address}.`,
    step.threadWithPrevious && thread
      ? `Reply inside the existing thread (mail thread id ${thread.id}) so they have the history in front of them.`
      : "Start a new thread.",
    mayAutoSend
      ? "You are authorized to send this yourself. Do so once you are happy with it."
      : "Write it as a DRAFT and stop. A human reviews and presses Send — do not send it yourself.",
    "",
    "## Rules",
    "- One ask. Never bundle two.",
    "- Reference something real and checkable. Cite it.",
    "- If you cannot find a genuine reason to write, say so plainly and write nothing. A skipped touch costs nothing; a generic one costs the relationship.",
    "- Never mail somebody who has unsubscribed or is suppressed. The send will be refused.",
  );

  return lines.filter((line) => line !== "").join("\n");
}

/** Hand a fired signal to an AI employee and let it decide what to do. */
async function handleSignal(handoff: {
  signal: { companyId: string; name: string; employeeId: string | null };
  row: Record<string, unknown>;
  config: Record<string, unknown>;
  contactId: string | null;
  customerId: string | null;
}): Promise<{ ok: boolean; detail: string }> {
  const employeeId = handoff.signal.employeeId;
  if (!employeeId) {
    return { ok: false, detail: "This signal has no AI employee assigned." };
  }
  const instruction =
    typeof handoff.config.instruction === "string" ? handoff.config.instruction : "";

  const prompt = [
    `The "${handoff.signal.name}" signal fired.`,
    "",
    "## The row that triggered it",
    "```json",
    JSON.stringify(handoff.row, null, 2).slice(0, 4_000),
    "```",
    "",
    handoff.contactId ? `Contact id: ${handoff.contactId}` : "",
    handoff.customerId ? `Customer id: ${handoff.customerId}` : "",
    "",
    "## What to do",
    instruction || "Decide what this warrants and act within your grants. Log what you did.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const result = await chatWithEmployee(handoff.signal.companyId, employeeId, prompt, []);
  return { ok: result.status === "ok", detail: result.reply.slice(0, DETAIL_CAP) };
}

/**
 * Install the seams and start both heartbeats.
 *
 * Neither tick is awaited: a slow first pass must not gate server startup, and
 * both are written to never reject. The leases keep two replicas from doing the
 * same work — see services/schedulerLeases.ts.
 */
export function bootRevenue(): void {
  setTouchDrafter(draftTouch);
  setSignalHandler(handleSignal);

  if (sequenceTimer) clearInterval(sequenceTimer);
  sequenceTimer = setInterval(() => {
    if (sequenceTicking) return;
    sequenceTicking = true;
    void withSchedulerLease("revenue-sequences", HEARTBEAT_INTERVAL_MS * 3, async () => {
      await tickSequences();
    })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[revenue] sequence heartbeat failed:", err);
      })
      .finally(() => {
        sequenceTicking = false;
      });
  }, HEARTBEAT_INTERVAL_MS);

  if (signalTimer) clearInterval(signalTimer);
  signalTimer = setInterval(() => {
    if (signalTicking) return;
    signalTicking = true;
    void withSchedulerLease("revenue-signals", HEARTBEAT_INTERVAL_MS * 3, async () => {
      await tickSignals();
    })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[revenue] signal heartbeat failed:", err);
      })
      .finally(() => {
        signalTicking = false;
      });
  }, HEARTBEAT_INTERVAL_MS);
}

/** Stop both heartbeats. The backup restore path destroys the DataSource. */
export function stopRevenue(): void {
  if (sequenceTimer) clearInterval(sequenceTimer);
  if (signalTimer) clearInterval(signalTimer);
  sequenceTimer = null;
  signalTimer = null;
}
