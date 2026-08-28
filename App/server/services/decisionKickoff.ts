import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Conversation } from "../db/entities/Conversation.js";
import { Decision, DecisionPickupStatus } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { chatWithEmployee } from "./chat.js";
import { getActiveModel } from "./models.js";
import { parseDecisionOptions } from "./decisions.js";

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

/** Keep the stored report inside a size the stack can render. */
const SUMMARY_CAP = 8_000;

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
}): Promise<void> {
  const { companyId, decisionId } = args;
  if (inFlight.has(decisionId)) return;

  const repo = AppDataSource.getRepository(Decision);
  // Claim first, ask questions later: whoever flips `none` → `running` owns the
  // session. A second caller sees zero affected rows and leaves.
  const claim = await repo.update(
    { id: decisionId, companyId, status: "decided", pickupStatus: "none" },
    { pickupStatus: "running", pickupStartedAt: new Date(), pickupFinishedAt: null },
  );
  if (!claim.affected) return;

  inFlight.add(decisionId);
  try {
    const decision = await repo.findOneBy({ id: decisionId, companyId });
    if (!decision) return;

    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: decision.employeeId,
      companyId,
    });
    if (!employee) {
      await settle(decision, "skipped", "The AI employee that asked this has been deleted.");
      return;
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
      return;
    } else {
      chatOptions = {
        requesterUserId: args.requesterUserId,
        requesterSessionVersion: args.requesterSessionVersion,
      };
    }
    if (!(await getActiveModel(employee.id))) {
      await settle(
        decision,
        "skipped",
        `${employee.name} has no AI Model connected, so nothing could start now. ` +
          "Your answer is on their journal and reaches them on their next run.",
      );
      return;
    }

    const runChat = args.runChat ?? chatWithEmployee;
    const result = await runChat(
      companyId,
      employee.id,
      await composePickupBrief(decision),
      [],
      chatOptions,
    );
    const reply = result.reply.trim() || "(no reply)";
    if (result.status === "ok") {
      await settle(decision, "done", reply);
      await journal(decision, `Picked up the decision "${decision.title}"`, reply);
    } else {
      await settle(decision, "failed", reply);
    }
  } catch (err) {
    // A throw anywhere above must still land the row in a terminal state —
    // otherwise the stack shows a spinner nobody will ever clear.
    const decision = await repo.findOneBy({ id: decisionId, companyId });
    if (decision) {
      await settle(decision, "failed", err instanceof Error ? err.message : String(err));
    }
  } finally {
    inFlight.delete(decisionId);
  }
}

async function settle(
  decision: Decision,
  status: DecisionPickupStatus,
  summary: string,
): Promise<void> {
  await AppDataSource.getRepository(Decision).update(
    { id: decision.id, companyId: decision.companyId },
    {
      pickupStatus: status,
      pickupSummary: summary.slice(0, SUMMARY_CAP),
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
    "- Your reply is shown to the team on the decision itself, so make it a short report: what you did and where it landed.",
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
