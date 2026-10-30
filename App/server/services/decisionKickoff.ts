import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Conversation } from "../db/entities/Conversation.js";
import { Decision, DecisionPickupStatus } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import type { AIModel } from "../db/entities/AIModel.js";
import type { AIModelWait } from "../db/entities/AIModelWait.js";
import { chatWithEmployee } from "./chat.js";
import { isModelAvailable } from "./modelAvailability.js";
import {
  parseWaitPayload,
  waitForModel,
  type ModelWaitHandler,
  type ModelWaitResult,
} from "./modelWaits.js";
import { getActiveModel } from "./models.js";
import { emitResourceChange } from "./resourceEvents.js";
import { parseDecisionOptions } from "./decisions.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { routineDeliveryPolicy, routineNeedsWorkReview } from "./proactive/policy.js";

/**
 * Pickup — the work session that starts the moment a human answers a Decision.
 *
 * Without this, answering only wrote a row and a journal entry, and the
 * employee read the answer whenever it next happened to run: its next routine
 * tick, or the next time somebody chatted with it. For a question raised by a
 * daily routine that is up to a day of a drafted reply sitting unsent, which is
 * the opposite of what pressing a button feels like it should do.
 *
 * So answering starts a session immediately, briefing the employee with its own
 * question, the option the human picked, their note, and where it was working
 * when it asked. The mechanics deliberately mirror `todoKickoff.ts` — assigning
 * a todo is the same shape of "go" signal — including its degradation rules:
 *
 *  - **No AI Model connected → `skipped`, not `failed`.** A fresh self-host
 *    uses the stack before anyone connects a brain, and the answer still
 *    reaches the employee through its journal on the next run.
 *  - **The claim is a conditional UPDATE.** Two humans racing the same row (or
 *    a retry landing on top of a live session) start exactly one session.
 *  - **A crash mid-session is swept on read**, not left spinning forever — see
 *    `reconcileStalePickups` in `decisions.ts`, which owns every "fix the row
 *    when somebody looks at it" rule.
 *
 * This is still not an Approval. The session runs under the employee's own
 * authority, delegated from the Member who answered, and every privileged thing
 * it then tries meets its own gate.
 */

/**
 * Decisions with a session executing in this process. The conditional UPDATE
 * below is the real guard; this only saves the round-trip. In-process only — a
 * restart clears it, which is correct because the sessions it tracked died with
 * the process.
 */
const inFlight = new Set<string>();

/** Keep the stored log inside a size the stack can render. */
const SUMMARY_CAP = 8_000;
/** The report is the employee's final message; a few short paragraphs at most. */
const REPORT_CAP = 2_000;

export async function kickoffDecision(args: {
  companyId: string;
  decisionId: string;
  requesterUserId?: string;
  /**
   * The answering Member's browser auth epoch. Null when they answered with an
   * API key: delegated Member authority is only ever granted to a real browser
   * session, and quietly promoting a key to employee authority would hand a
   * programmatic caller more reach than it signed in with. Those rows record a
   * `skipped` pickup instead — the journal still carries the answer.
   */
  requesterSessionVersion?: number | null;
  /**
   * `"employee"` when the answer came from an AI decider under a
   * DecisionPolicy rule (M53): there is no Member to delegate from, so the
   * pickup runs under the asker's own authority — the handoff-kickoff shape,
   * and exactly the authority its Routine Runs already have.
   */
  authority?: "member" | "employee";
  /**
   * Seam for tests — the real work session is a model turn. Mirrors the mail
   * assistant's `runChat` injection rather than inventing a second pattern.
   */
  runChat?: typeof chatWithEmployee;
  /**
   * Carry on a pickup that waited for its AI Model (`decisionPickupWait`):
   * claims the `waiting` row rather than an untouched one.
   */
  resume?: boolean;
}): Promise<PickupKickoffOutcome> {
  const { companyId, decisionId } = args;
  if (inFlight.has(decisionId)) return "not_started";

  const repo = AppDataSource.getRepository(Decision);
  // Preparation-only origins persist `skipped` when the question is created.
  // Answering leaves that marker intact, so neither a human nor an AI answer
  // can shed the originating turn's delivery ceiling by starting this session.
  // Claim first, ask questions later: whoever flips `none` → `running` owns the
  // session. A second caller sees zero affected rows and leaves.
  const claim = await repo.update(
    {
      id: decisionId,
      companyId,
      status: "decided",
      pickupStatus: args.resume ? "waiting" : "none",
    },
    { pickupStatus: "running", pickupStartedAt: new Date(), pickupFinishedAt: null },
  );
  if (!claim.affected) return "not_started";

  inFlight.add(decisionId);
  try {
    const decision = await repo.findOneBy({ id: decisionId, companyId });
    if (!decision) return "not_started";

    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: decision.employeeId,
      companyId,
    });
    if (!employee) {
      await settle(decision, "skipped", "The AI employee that asked this has been deleted.");
      return "skipped";
    }
    let chatOptions: Parameters<typeof chatWithEmployee>[4];
    if (args.authority === "employee") {
      chatOptions = { toolAuthority: "employee" };
    } else if (args.requesterSessionVersion == null || !args.requesterUserId) {
      await settle(
        decision,
        "skipped",
        `This was answered with an API key, which cannot delegate authority to a ` +
          `work session. Your answer is on ${employee.name}'s journal and reaches ` +
          "them on their next run.",
      );
      return "skipped";
    } else {
      chatOptions = {
        requesterUserId: args.requesterUserId,
        requesterSessionVersion: args.requesterSessionVersion,
      };
    }
    // Older Decisions could start a fresh full-authority chat when answered.
    // Restore the original source restrictions even for an AI decision policy.
    if (decision.routineId) {
      const routine = await AppDataSource.getRepository(Routine).findOneBy({
        id: decision.routineId,
        employeeId: employee.id,
      });
      if (!routine || !routine.enabled) {
        await settle(
          decision,
          "skipped",
          "The source Routine was disabled or removed. The answer was saved.",
        );
        return "skipped";
      }
      const run = decision.runId
        ? await AppDataSource.getRepository(Run).findOneBy({
            id: decision.runId,
            routineId: routine.id,
          })
        : null;
      chatOptions = {
        ...chatOptions,
        routineId: routine.id,
        mailDeliveryMode: routineDeliveryPolicy(routine).mailDeliveryMode,
        selfReviewOnly: routine.selfReviewOnly,
        proactiveReview: routineNeedsWorkReview(routine, run?.triggerKind ?? "schedule"),
      };
    }
    if (decision.mailThreadId) {
      chatOptions = {
        ...chatOptions,
        mailThreadId: decision.mailThreadId,
        // Answering a question records information; it never authorizes an
        // automatic mailbox draft or send. Any resulting reply returns as an
        // exact Decision-stack review.
        mailDeliveryMode: "review",
        proactiveReview: true,
      };
    }
    const model = await getActiveModel(employee.id);
    if (!model) {
      await settle(
        decision,
        "skipped",
        `${employee.name} has no AI Model connected, so nothing could start now. ` +
          "Your answer is on their journal and reaches them on their next run.",
      );
      return "skipped";
    }
    // The AI Model is unavailable: the work waits for it — the same session,
    // under the same authority — and starts by itself when the model is back.
    // Nothing is settled, journaled or retried meanwhile.
    const wait = async (): Promise<PickupKickoffOutcome> => {
      await waitForPickup(decision, employee, model, args);
      return "waiting";
    };
    if (!modelAnswers(model)) return await wait();

    const runChat = args.runChat ?? chatWithEmployee;
    let pickupBrief = await composePickupBrief(decision);
    if (chatOptions.mailDeliveryMode === "review") {
      pickupBrief +=
        "\n\nAny email you prepare must use request_mail_review. Keep its exact recipients, subject, body and files in the Decision stack; do not create a Gmail or IMAP draft and do not send it.";
    }
    const result = await runChat(companyId, employee.id, pickupBrief, [], chatOptions);
    if (result.status === "error" && result.unavailable) return await wait();
    const reply = result.reply.trim() || "(no reply)";
    if (result.status === "ok") {
      // The final message is the report people read; the reply keeps every
      // step the session narrated on the way, for whoever wants them.
      const report = result.finalText?.trim() || null;
      await settle(decision, "done", reply, report);
      await journal(decision, `Picked up the decision "${decision.title}"`, report ?? reply);
      return "done";
    }
    await settle(decision, "failed", reply);
    return "failed";
  } catch (err) {
    // A throw anywhere above must still land the row in a terminal state —
    // otherwise the stack shows a spinner nobody will ever clear.
    const decision = await repo.findOneBy({ id: decisionId, companyId });
    if (decision) {
      await settle(decision, "failed", err instanceof Error ? err.message : String(err));
    }
    return "failed";
  } finally {
    inFlight.delete(decisionId);
  }
}

/** How a pickup kickoff ended. `waiting` waits for its AI Model and starts by itself. */
export type PickupKickoffOutcome = "not_started" | "waiting" | "done" | "failed" | "skipped";

/** The Member authority (or the employee's own) a pickup that waits carries to its resume. */
type PickupWaitPayload = {
  authority: "member" | "employee";
  requesterUserId: string | null;
  requesterSessionVersion: number | null;
};

function modelAnswers(model: AIModel): boolean {
  try {
    return isModelAvailable(model);
  } catch {
    return true;
  }
}

async function waitForPickup(
  decision: Decision,
  employee: AIEmployee,
  model: AIModel,
  args: Parameters<typeof kickoffDecision>[0],
): Promise<void> {
  await AppDataSource.getRepository(Decision).update(
    { id: decision.id, companyId: decision.companyId, pickupStatus: "running" },
    {
      pickupStatus: "waiting",
      pickupSummary: `${employee.name}'s AI Model is unavailable, so the work waits for it. It starts by itself as soon as the model is back.`,
      pickupReport: null,
      pickupFinishedAt: null,
    },
  );
  // The answering Member's exact auth epoch travels with the wait: the work
  // that starts later runs under that authority or not at all — a password
  // reset or a lost Membership meanwhile refuses it, as for any chat turn.
  const payload: PickupWaitPayload = {
    authority: args.authority === "employee" ? "employee" : "member",
    requesterUserId: args.requesterUserId ?? null,
    requesterSessionVersion: args.requesterSessionVersion ?? null,
  };
  await waitForModel({
    kind: "decision_pickup",
    targetId: decision.id,
    companyId: decision.companyId,
    employeeId: employee.id,
    model,
    payload,
  });
  emitResourceChange(decision.companyId, "decision", undefined, { trigger: false });
}

/**
 * A pickup that waited for its AI Model, started once the model is back:
 * `kickoffDecision` again, claiming the waiting row, with every check it makes
 * — the asker still here, the Routine still on, the answering Member still a
 * Member on the same session — made again now.
 */
export const decisionPickupWait: ModelWaitHandler = {
  concurrency: 2,
  resume: async (wait: AIModelWait): Promise<ModelWaitResult> => {
    const payload = parseWaitPayload<PickupWaitPayload>(wait);
    const outcome = await kickoffDecision({
      companyId: wait.companyId,
      decisionId: wait.targetId,
      authority: payload.authority === "employee" ? "employee" : "member",
      requesterUserId: payload.requesterUserId ?? undefined,
      requesterSessionVersion: payload.requesterSessionVersion ?? null,
      resume: true,
    });
    return outcome === "waiting" ? { status: "waiting" } : { status: "done" };
  },
  abandon: async (wait) => {
    const decision = await AppDataSource.getRepository(Decision).findOneBy({
      id: wait.targetId,
      companyId: wait.companyId,
    });
    if (!decision || decision.pickupStatus !== "waiting") return;
    await settle(
      decision,
      "skipped",
      "The AI Model kept becoming unavailable, so the work did not start. The answer is on the employee's journal and reaches them on their next run.",
    );
  },
};

/**
 * Land the pickup in a terminal state. Both texts are shown to every Member
 * on the Decision stack, so they are scrubbed of credential-shaped material
 * the session may have quoted, the same way the question itself is.
 */
async function settle(
  decision: Decision,
  status: DecisionPickupStatus,
  summary: string,
  report: string | null = null,
): Promise<void> {
  await AppDataSource.getRepository(Decision).update(
    { id: decision.id, companyId: decision.companyId },
    {
      pickupStatus: status,
      pickupSummary: redactSensitiveText(summary).slice(0, SUMMARY_CAP),
      pickupReport: report ? redactSensitiveText(report).slice(0, REPORT_CAP) || null : null,
      pickupFinishedAt: new Date(),
    },
  );
}

/**
 * The brief.
 *
 * It has to reconstruct enough context for an employee that is starting a fresh
 * session with none: what it asked, what it offered, what came back, and where
 * it was standing when it asked. The last part is why the provenance columns
 * exist — "carry on with the routine you were running" is useless without
 * naming the routine.
 */
async function composePickupBrief(decision: Decision): Promise<string> {
  const options = parseDecisionOptions(decision.optionsJson);
  const chosen = options.find((o) => o.id === decision.chosenOptionId);
  const decider = decision.decidedByUserId
    ? await AppDataSource.getRepository(User).findOneBy({ id: decision.decidedByUserId })
    : null;
  const aiDecider = decision.decidedByEmployeeId
    ? await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: decision.decidedByEmployeeId,
      })
    : null;
  const who = decider
    ? decider.name || decider.email
    : aiDecider
      ? `${aiDecider.name} (your company's decision policy routed the question to them)`
      : "A teammate";

  const lines = [
    `You stopped and asked: **${decision.title}**`,
    "",
    `${who} has answered: **${decision.chosenOptionLabel ?? "(unknown option)"}**`,
  ];
  if (chosen?.detail) lines.push(`That option means: ${chosen.detail}`);
  if (decision.note) lines.push("", `Their note: ${decision.note}`);
  if (decision.body) {
    lines.push("", "The context you stacked with the question:", "---", decision.body, "---");
  }

  const where = await describeProvenance(decision);
  if (where) lines.push("", where);

  lines.push(
    "",
    "---",
    "Carry on now — this session exists so you don't have to wait for your next run.",
    "- Do the work the answer unblocks, with your tools. Don't re-ask what has just been answered.",
    "- If the answer changed what you should do, do the changed thing rather than the original plan.",
    "- If you genuinely cannot proceed, say exactly what is missing — do not stack another decision for the same question.",
    "- Your final message is shown to the team on the decision itself, so make it a short report in plain words: " +
      "one or two sentences on what you did and where it landed, without narrating each step.",
  );
  return lines.join("\n");
}

async function describeProvenance(decision: Decision): Promise<string | null> {
  if (decision.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneBy({
      id: decision.routineId,
    });
    if (routine) {
      return `You asked this while running your routine "${routine.name}"${
        decision.runId ? ` (run ${decision.runId})` : ""
      }. Resume that work.`;
    }
  }
  if (decision.mailThreadId) {
    const thread = await AppDataSource.getRepository(MailThread).findOneBy({
      id: decision.mailThreadId,
    });
    if (thread) {
      return (
        `You asked this while working the email thread "${thread.subject || "(no subject)"}" — ` +
        `id ${thread.id}, which you can pass as \`threadId\` to the mail tools.`
      );
    }
  }
  if (decision.conversationId) {
    const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
      id: decision.conversationId,
    });
    if (conversation) {
      return `You asked this during the chat "${conversation.title ?? "New conversation"}".`;
    }
  }
  return null;
}

async function journal(decision: Decision, title: string, body: string): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId: decision.employeeId,
        kind: "system",
        title,
        body: body.slice(0, SUMMARY_CAP),
        runId: null,
        routineId: decision.routineId,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // Same philosophy as the decision journal itself: the report is already
    // durable on the row, and the stack reads it from there.
    // eslint-disable-next-line no-console
    console.warn("[decisions] pickup journal write failed", err);
  }
}
