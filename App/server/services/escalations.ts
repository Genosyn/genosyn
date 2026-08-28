import { In, IsNull, LessThan, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { Handoff } from "../db/entities/Handoff.js";
import { Membership } from "../db/entities/Membership.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { Routine } from "../db/entities/Routine.js";
import { createNotifications, type CreateNotificationInput } from "./notifications.js";
import { managingMemberIdForEmployee } from "./reportingLine.js";
import { redactApprovalSummary } from "./approvalRedaction.js";

/**
 * The stall sweep — the system noticing that autonomous work has stopped.
 *
 * Every human gate in the product could previously dead-end in silence: a
 * pending Approval never expires, so a gated Routine tick nobody answered was
 * simply lost; an unanswered Decision blocks its employee indefinitely; a
 * Handoff's `dueAt` was documented as unenforced. Each of those got exactly one
 * bell at creation and then nothing, forever.
 *
 * This sweep runs on the scheduler heartbeat and re-pages the humans who can
 * unblock each stalled row, exactly once per row. "Exactly once" is a durable
 * `stallRemindedAt` stamp on the row itself, not a lookup in the notification
 * feed: a Member can delete their own read notifications, so a feed-derived
 * marker would re-arm the nag every time somebody tidied their bell — and
 * because the stamp is part of the query, the sweep never pages past rows it
 * has already handled (a fixed page of the oldest stalled rows would otherwise
 * wedge permanently behind the first 25 it reminded).
 *
 * It never acts on the stalled row: answering stays a human's move, the sweep
 * only ends the silence.
 */

/** How long a human gate may sit unanswered before the sweep re-pages. */
const STALL_AFTER_MS = 24 * 60 * 60 * 1000;

/** Per-category cap per pass; the sweep runs every heartbeat, so a backlog drains. */
const MAX_PER_SWEEP = 25;

/**
 * Recipients for a company-wide page. Members who have left keep their
 * account (and their registered push devices), so every audience here is
 * derived from live `Membership` rows rather than from an id stored on the
 * stalled row.
 */
async function ownersAndAdmins(companyId: string): Promise<string[]> {
  const memberships = await AppDataSource.getRepository(Membership).find({
    where: { companyId, role: In(["owner", "admin"]) },
  });
  return memberships.map((m) => m.userId);
}

async function isCompanyMember(companyId: string, userId: string): Promise<boolean> {
  return (
    (await AppDataSource.getRepository(Membership).countBy({ companyId, userId })) > 0
  );
}

function hoursSince(from: Date, now: Date): number {
  return Math.max(1, Math.round((now.getTime() - from.getTime()) / (60 * 60 * 1000)));
}

/**
 * Claim a row for reminding. The conditional update is what keeps two
 * schedulers (or a retried pass) from double-paging: whoever flips
 * `stallRemindedAt` from null owns the page, and a loser writes nothing.
 */
async function claimStallReminder(
  entity: typeof Approval | typeof Decision | typeof Handoff | typeof RevisionProposal,
  id: string,
  now: Date,
): Promise<boolean> {
  const claim = await AppDataSource.getRepository(entity).update(
    { id, stallRemindedAt: IsNull() },
    { stallRemindedAt: now },
  );
  return claim.affected === 1;
}

async function sweepStaleApprovals(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STALL_AFTER_MS);
  const stale = await AppDataSource.getRepository(Approval).find({
    where: { status: "pending", requestedAt: LessThan(cutoff), stallRemindedAt: IsNull() },
    order: { requestedAt: "ASC" },
    take: MAX_PER_SWEEP,
  });

  for (const approval of stale) {
    const [company, employee, routine, userIds] = await Promise.all([
      AppDataSource.getRepository(Company).findOneBy({ id: approval.companyId }),
      AppDataSource.getRepository(AIEmployee).findOneBy({ id: approval.employeeId }),
      approval.routineId
        ? AppDataSource.getRepository(Routine).findOneBy({ id: approval.routineId })
        : Promise.resolve(null),
      ownersAndAdmins(approval.companyId),
    ]);
    if (!company || userIds.length === 0) continue;
    if (!(await claimStallReminder(Approval, approval.id, now))) continue;
    const what =
      approval.kind === "routine" && routine
        ? `run "${routine.name}"`
        : (redactApprovalSummary(approval.title) ?? "an action");
    const inputs: CreateNotificationInput[] = userIds.map((userId) => ({
      companyId: approval.companyId,
      userId,
      kind: "approval_stale" as const,
      title: `An approval has waited ${hoursSince(approval.requestedAt, now)}h: ${what}`,
      body:
        "Nothing runs until a human approves or rejects it — the gated work is " +
        "lost, not queued, if this is never answered.",
      link: `/c/${company.slug}/approvals`,
      actorKind: employee ? ("ai" as const) : ("system" as const),
      actorId: employee?.id ?? null,
      entityKind: "approval" as const,
      entityId: approval.id,
    }));
    await createNotifications(inputs);
  }
}

async function sweepStaleDecisions(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STALL_AFTER_MS);
  const stale = await AppDataSource.getRepository(Decision).find({
    where: [
      {
        status: "pending",
        createdAt: LessThan(cutoff),
        stallRemindedAt: IsNull(),
        expiresAt: IsNull(),
      },
      {
        status: "pending",
        createdAt: LessThan(cutoff),
        stallRemindedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
    ],
    order: { createdAt: "ASC" },
    take: MAX_PER_SWEEP,
  });

  for (const decision of stale) {
    const [company, employee] = await Promise.all([
      AppDataSource.getRepository(Company).findOneBy({ id: decision.companyId }),
      AppDataSource.getRepository(AIEmployee).findOneBy({ id: decision.employeeId }),
    ]);
    if (!company || !employee) continue;
    // Same audience rule as the original decision_pending bell: the named
    // assignee if there is one, otherwise the company's owners and admins.
    // An assignee who has since left the company is not a recipient — nothing
    // clears `assigneeUserId` when a Member is removed, and their push
    // devices outlive the membership — so the page falls back to the people
    // who can still answer it.
    const assigneeIsMember =
      decision.assigneeUserId !== null &&
      (await isCompanyMember(decision.companyId, decision.assigneeUserId));
    const userIds = assigneeIsMember
      ? [decision.assigneeUserId as string]
      : await ownersAndAdmins(decision.companyId);
    if (userIds.length === 0) continue;
    if (!(await claimStallReminder(Decision, decision.id, now))) continue;
    const inputs: CreateNotificationInput[] = userIds.map((userId) => ({
      companyId: decision.companyId,
      userId,
      kind: "decision_stale" as const,
      title: `${employee.name} has been blocked ${hoursSince(decision.createdAt, now)}h on: ${decision.title}`,
      body: "They stopped to ask and cannot carry on until someone picks an option.",
      link: `/c/${company.slug}/decisions`,
      actorKind: "ai" as const,
      actorId: employee.id,
      entityKind: "decision" as const,
      entityId: decision.id,
    }));
    await createNotifications(inputs);
  }
}

async function sweepOverdueHandoffs(now: Date): Promise<void> {
  // `LessThan` never matches NULL, so rows without a deadline are excluded by
  // the same predicate that finds the overdue ones.
  const overdue = await AppDataSource.getRepository(Handoff).find({
    where: { status: "pending", dueAt: LessThan(now), stallRemindedAt: IsNull() },
    order: { dueAt: "ASC" },
    take: MAX_PER_SWEEP,
  });

  for (const handoff of overdue) {
    const [company, receiver, sender] = await Promise.all([
      AppDataSource.getRepository(Company).findOneBy({ id: handoff.companyId }),
      AppDataSource.getRepository(AIEmployee).findOneBy({ id: handoff.toEmployeeId }),
      AppDataSource.getRepository(AIEmployee).findOneBy({ id: handoff.fromEmployeeId }),
    ]);
    if (!company || !receiver) continue;
    // Escalate up the receiver's reporting line to the human accountable for
    // it, widened to owners/admins so a company with no reporting lines still
    // hears about it. `managingMemberIdForEmployee` only returns a live
    // Member, so a manager who has left does not receive this.
    const userIds = new Set(await ownersAndAdmins(handoff.companyId));
    const managerId = await managingMemberIdForEmployee(handoff.companyId, receiver.id);
    if (managerId) userIds.add(managerId);
    if (userIds.size === 0) continue;
    if (!(await claimStallReminder(Handoff, handoff.id, now))) continue;
    const inputs: CreateNotificationInput[] = [...userIds].map((userId) => ({
      companyId: handoff.companyId,
      userId,
      kind: "handoff_overdue" as const,
      title: `Handoff overdue: "${handoff.title}"`,
      body: `${sender?.name ?? "An AI employee"} handed this to ${receiver.name} with a deadline that has passed and it is still pending.`,
      link: `/c/${company.slug}/employees/${receiver.slug}/handoffs`,
      actorKind: "ai" as const,
      actorId: receiver.id,
      entityKind: "handoff" as const,
      entityId: handoff.id,
    }));
    await createNotifications(inputs);
  }
}

async function sweepStaleRevisionProposals(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STALL_AFTER_MS);
  const stale = await AppDataSource.getRepository(RevisionProposal).find({
    where: { status: "pending", createdAt: LessThan(cutoff), stallRemindedAt: IsNull() },
    order: { createdAt: "ASC" },
    take: MAX_PER_SWEEP,
  });

  for (const proposal of stale) {
    const [company, employee] = await Promise.all([
      AppDataSource.getRepository(Company).findOneBy({ id: proposal.companyId }),
      AppDataSource.getRepository(AIEmployee).findOneBy({ id: proposal.employeeId }),
    ]);
    if (!company || !employee) continue;
    // The create-time audience: owners/admins plus the employee's manager,
    // re-derived from live rows for the same left-the-company reason above.
    const userIds = new Set(await ownersAndAdmins(proposal.companyId));
    const managerId = await managingMemberIdForEmployee(proposal.companyId, employee.id);
    if (managerId) userIds.add(managerId);
    if (userIds.size === 0) continue;
    if (!(await claimStallReminder(RevisionProposal, proposal.id, now))) continue;
    const inputs: CreateNotificationInput[] = [...userIds].map((userId) => ({
      companyId: proposal.companyId,
      userId,
      kind: "revision_stale" as const,
      title: `A revision has waited ${hoursSince(proposal.createdAt, now)}h: ${proposal.targetLabel}`,
      body: `${employee.name} proposed this edit and cannot apply it itself — someone must apply or decline it.`,
      link: `/c/${company.slug}/revisions`,
      actorKind: "ai" as const,
      actorId: employee.id,
      entityKind: "revision_proposal" as const,
      entityId: proposal.id,
    }));
    await createNotifications(inputs);
  }
}

/**
 * One pass over every stallable human gate. Called from the scheduler
 * heartbeat; each category is independently best-effort so one broken query
 * cannot silence the others.
 */
export async function sweepStalledWork(now: Date = new Date()): Promise<void> {
  await sweepStaleApprovals(now).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[escalations] stale approval sweep failed:", err);
  });
  await sweepStaleDecisions(now).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[escalations] stale decision sweep failed:", err);
  });
  await sweepOverdueHandoffs(now).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[escalations] overdue handoff sweep failed:", err);
  });
  await sweepStaleRevisionProposals(now).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[escalations] stale revision sweep failed:", err);
  });
}
