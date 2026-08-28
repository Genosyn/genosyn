import { IsNull, LessThan, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Decision } from "../db/entities/Decision.js";
import { DecisionPolicy } from "../db/entities/DecisionPolicy.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { chatWithEmployee } from "./chat.js";
import { getActiveModel } from "./models.js";
import { recordAudit } from "./audit.js";
import { notifyDecisionPending, parseDecisionOptions } from "./decisions.js";

/**
 * Decision routing (M53): the "who decides what" layer, no longer hardcoded
 * to "a human, always".
 *
 * The envelope that makes this defensible is the Decision primitive itself,
 * unchanged: answering fires no side effect, and anything privileged the
 * asker does with the answer still meets its own Approval gates. So routing a
 * judgment call to another AI Employee widens nothing — it moves a question
 * between inboxes. What routing must still guarantee, and this module owns:
 *
 *  - **Human-only is the default.** No enabled rule, no routing.
 *  - **A named human assignee always wins.** The employee explicitly asked a
 *    person; a rule never overrides that.
 *  - **The bell is skipped, never lost.** A routed Decision skips the
 *    creation-time page — that is the point — but a decline or the fallback
 *    fuse sends exactly the bell that was skipped.
 *  - **Only the routed decider may answer**, through `decide_decision`, and
 *    an AI answer is recorded as one (`decidedByEmployeeId`), audited, and
 *    journaled to the asker like a human answer is.
 */

/** How long the decider holds the question before humans are paged anyway. */
export const ROUTED_DECISION_FUSE_MS = 4 * 60 * 60 * 1000;

/** Per-pass bound for the fallback sweep, the escalation-sweep convention. */
const MAX_PER_SWEEP = 25;

const SUMMARY_CAP = 4_000;

/**
 * Resolve the decider a company's rules name for this asking employee, or
 * null when no enabled rule matches or the named decider cannot serve (gone,
 * self, or brainless — a decider with no AI Model connected would hold the
 * question and answer nothing).
 */
export async function resolveDecider(
  companyId: string,
  askingEmployeeId: string,
): Promise<AIEmployee | null> {
  const rules = await AppDataSource.getRepository(DecisionPolicy).find({
    where: { companyId, enabled: true },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  const rule = rules.find(
    (r) => r.askingEmployeeId === null || r.askingEmployeeId === askingEmployeeId,
  );
  if (!rule) return null;

  let deciderId: string | null = null;
  if (rule.deciderKind === "manager") {
    const asker = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: askingEmployeeId,
      companyId,
    });
    deciderId = asker?.reportsToEmployeeId ?? null;
  } else {
    deciderId = rule.deciderEmployeeId;
  }
  if (!deciderId || deciderId === askingEmployeeId) return null;
  const decider = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: deciderId,
    companyId,
  });
  if (!decider) return null;
  if (!(await getActiveModel(decider.id))) return null;
  return decider;
}

/**
 * Route a freshly created Decision if a rule says to. Returns the decider
 * when routed (the caller skips the human bell and fires the kickoff), null
 * when the ordinary human flow should proceed.
 */
export async function tryRouteDecision(decision: Decision): Promise<AIEmployee | null> {
  // The employee asked a person by name; that request is honored verbatim.
  if (decision.assigneeUserId) return null;
  const decider = await resolveDecider(decision.companyId, decision.employeeId);
  if (!decider) return null;
  const claim = await AppDataSource.getRepository(Decision).update(
    { id: decision.id, status: "pending", routedToEmployeeId: IsNull() },
    { routedToEmployeeId: decider.id, routedAt: new Date() },
  );
  if (claim.affected !== 1) return null;
  decision.routedToEmployeeId = decider.id;
  decision.routedAt = new Date();
  await recordAudit({
    companyId: decision.companyId,
    actorKind: "system",
    action: "decision.route",
    targetType: "decision",
    targetId: decision.id,
    targetLabel: decision.title,
    metadata: { deciderEmployeeId: decider.id },
  });
  return decider;
}

/**
 * Brief the decider in a background session under its own employee authority
 * — the handoff-kickoff shape: investigate with its tools if needed, then
 * settle the row through `decide_decision`. A session that cannot run or
 * fails un-routes immediately so the question is never parked behind a dead
 * decider.
 */
export async function kickoffRoutedDecision(args: {
  companyId: string;
  decisionId: string;
  /** Test seam, mirroring the other kickoffs' `runChat` injection. */
  runChat?: typeof chatWithEmployee;
}): Promise<void> {
  const repo = AppDataSource.getRepository(Decision);
  const decision = await repo.findOneBy({ id: args.decisionId, companyId: args.companyId });
  if (!decision || decision.status !== "pending" || !decision.routedToEmployeeId) return;
  const [decider, asker] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: decision.routedToEmployeeId,
      companyId: args.companyId,
    }),
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: decision.employeeId,
      companyId: args.companyId,
    }),
  ]);
  if (!decider) {
    await unrouteDecision(decision, "the routed decider no longer exists");
    return;
  }
  try {
    const runChat = args.runChat ?? chatWithEmployee;
    const result = await runChat(
      args.companyId,
      decider.id,
      await composeDeciderBrief(decision, asker),
      [],
      { toolAuthority: "employee" },
    );
    // The session settles the row via decide_decision. If it returned without
    // doing so, the question must not sit silently until the fuse — fall back
    // to humans now, with the reply as the reason.
    const fresh = await repo.findOneBy({ id: decision.id, companyId: args.companyId });
    if (
      fresh &&
      fresh.status === "pending" &&
      fresh.routedToEmployeeId === decider.id &&
      result.status !== "ok"
    ) {
      await unrouteDecision(fresh, `the decider session failed: ${result.reply.slice(0, 300)}`);
    }
  } catch (err) {
    const fresh = await repo.findOneBy({ id: decision.id, companyId: args.companyId });
    if (fresh && fresh.status === "pending" && fresh.routedToEmployeeId === decider.id) {
      await unrouteDecision(
        fresh,
        `the decider session failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function composeDeciderBrief(
  decision: Decision,
  asker: AIEmployee | null,
): Promise<string> {
  const options = parseDecisionOptions(decision.optionsJson);
  const from = asker ? `${asker.name} (${asker.role})` : "a teammate";
  const lines = [
    `${from} stopped and asked a question your company's decision policy routes to you: **${decision.title}**`,
  ];
  if (decision.body) {
    lines.push("", "Their context:", "---", decision.body, "---");
  }
  lines.push("", "The options they will act on:");
  for (const option of options) {
    lines.push(`- \`${option.id}\` — ${option.label}${option.detail ? ` (${option.detail})` : ""}`);
  }
  if (decision.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneBy({
      id: decision.routineId,
    });
    if (routine) lines.push("", `They asked this while running their routine "${routine.name}".`);
  }
  lines.push(
    "",
    "---",
    "Decide now — this session exists so their work unblocks in minutes, not days.",
    "- Investigate briefly with your tools if the answer needs evidence; don't build anything.",
    `- Then call \`decide_decision\` with decisionId "${decision.id}" and the \`option\` id you choose, plus a one-line note saying why.`,
    "- If this genuinely needs a human — money, people, anything outside your judgment — call " +
      `\`decide_decision\` with decisionId "${decision.id}" and a \`declineReason\` instead. Humans are paged the moment you decline.`,
    "- Answering performs no action by itself; the asker does the work under its own gates.",
  );
  return lines.join("\n");
}

/** Clear routing and send the human bell the routing skipped. */
async function unrouteDecision(decision: Decision, reason: string): Promise<void> {
  const claim = await AppDataSource.getRepository(Decision).update(
    { id: decision.id, status: "pending", routedToEmployeeId: Not(IsNull()) },
    { routedToEmployeeId: null, routedAt: null },
  );
  if (claim.affected !== 1) return;
  await recordAudit({
    companyId: decision.companyId,
    actorKind: "system",
    action: "decision.route_fallback",
    targetType: "decision",
    targetId: decision.id,
    targetLabel: decision.title,
    metadata: { reason },
  });
  decision.routedToEmployeeId = null;
  await notifyDecisionPending(decision);
}

export type EmployeeDecideOutcome =
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "conflict" }
  | { outcome: "unknown_option" }
  | { outcome: "declined" }
  | { outcome: "decided"; decision: Decision };

/**
 * The decider settles the row: exactly one of `optionId` / `declineReason`.
 * Guarded to the routed decider alone, claimed with the same conditional
 * UPDATE the human path uses, and recorded symmetrically — audit, journal to
 * the asker, then the asker's pickup session under its own employee
 * authority.
 */
export async function decideDecisionAsEmployee(params: {
  companyId: string;
  decisionId: string;
  deciderEmployeeId: string;
  optionId?: string;
  declineReason?: string;
  note?: string | null;
}): Promise<EmployeeDecideOutcome> {
  const repo = AppDataSource.getRepository(Decision);
  const decision = await repo.findOneBy({ id: params.decisionId, companyId: params.companyId });
  if (!decision) return { outcome: "not_found" };
  if (decision.routedToEmployeeId !== params.deciderEmployeeId) return { outcome: "forbidden" };
  if (decision.status !== "pending") return { outcome: "conflict" };

  const decider = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: params.deciderEmployeeId,
    companyId: params.companyId,
  });
  const deciderName = decider?.name ?? "A teammate";

  if (params.declineReason) {
    await recordAudit({
      companyId: params.companyId,
      actorEmployeeId: params.deciderEmployeeId,
      action: "decision.route_decline",
      targetType: "decision",
      targetId: decision.id,
      targetLabel: decision.title,
      metadata: { reason: params.declineReason.slice(0, 500) },
    });
    await unrouteDecision(decision, `${deciderName} declined: ${params.declineReason.slice(0, 300)}`);
    return { outcome: "declined" };
  }

  const option = parseDecisionOptions(decision.optionsJson).find((o) => o.id === params.optionId);
  if (!option) return { outcome: "unknown_option" };

  const note = params.note?.trim() ? params.note.trim().slice(0, 4_000) : null;
  const claim = await repo.update(
    { id: decision.id, companyId: params.companyId, status: "pending" },
    {
      status: "decided",
      chosenOptionId: option.id,
      chosenOptionLabel: option.label,
      note,
      decidedByEmployeeId: params.deciderEmployeeId,
      decidedByUserId: null,
      decidedAt: new Date(),
    },
  );
  if (!claim.affected) return { outcome: "conflict" };

  const updated = (await repo.findOneBy({ id: decision.id, companyId: params.companyId }))!;
  await recordAudit({
    companyId: params.companyId,
    actorEmployeeId: params.deciderEmployeeId,
    action: "decision.decide",
    targetType: "decision",
    targetId: decision.id,
    targetLabel: decision.title,
    metadata: { chose: option.label, via: "decision_policy" },
  });
  await journalToAsker(
    updated,
    `${deciderName} decided "${updated.title}": ${option.label}`,
    note ? `Their note: ${note}` : "",
  );
  // The asker is a blocked employee exactly as with a human answer — start
  // its pickup now, under its own authority (there is no Member to delegate).
  const { kickoffDecision } = await import("./decisionKickoff.js");
  void kickoffDecision({
    companyId: params.companyId,
    decisionId: decision.id,
    authority: "employee",
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[decisions] AI-answer pickup failed for ${decision.id}:`, err);
  });
  return { outcome: "decided", decision: updated };
}

async function journalToAsker(decision: Decision, title: string, body: string): Promise<void> {
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
    // eslint-disable-next-line no-console
    console.warn("[decisions] routing journal write failed", err);
  }
}

/**
 * The fallback fuse, on the scheduler heartbeat: a routed Decision still
 * pending past {@link ROUTED_DECISION_FUSE_MS} drops back to the human flow
 * with the bell it skipped. Exactly once per row — un-routing is the claim.
 */
export async function sweepRoutedDecisions(now: Date = new Date()): Promise<void> {
  const stale = await AppDataSource.getRepository(Decision).find({
    where: {
      status: "pending",
      routedToEmployeeId: Not(IsNull()),
      routedAt: LessThan(new Date(now.getTime() - ROUTED_DECISION_FUSE_MS)),
    },
    order: { routedAt: "ASC" },
    take: MAX_PER_SWEEP,
  });
  for (const decision of stale) {
    try {
      await unrouteDecision(decision, "the routed decider did not answer within the fuse");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[decisions] fuse fallback failed for ${decision.id}:`, err);
    }
  }
}
