import { In, IsNull, type EntityManager } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { withSerializedTransaction } from "../db/transactions.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Membership } from "../db/entities/Membership.js";
import { RevisionProposal, type RevisionProposalKind } from "../db/entities/RevisionProposal.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Skill } from "../db/entities/Skill.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
// The shared uuid-PK guard — see routineFolders.ts for the Postgres 22P02 story.
import { UUID_RE } from "./bases.js";
import { recordAudit } from "./audit.js";
import { createNotifications } from "./notifications.js";
import { managingMemberIdForEmployee } from "./reportingLine.js";
import { findRoutineParticipation } from "./routineParticipation.js";

/**
 * Revision proposals — the maker-checker half of the improvement loop (M52),
 * on the `FinanceProposal` spine: an AI Employee stages a full replacement
 * body for its own Soul, a Skill, or a Routine; nothing changes until an
 * owner/admin applies it; and apply refuses when the target drifted since the
 * proposal was written, so a human's concurrent edit is never silently
 * overwritten. To extend: add a kind to {@link RevisionProposalKind}, teach
 * {@link loadTarget} where its body lives, and nothing else changes.
 */

/** Bodies are whole documents; cap well above any sane Soul, below abuse. */
const MAX_BODY_CHARS = 100_000;
const MAX_RATIONALE_CHARS = 2_000;
const MAX_EVIDENCE_RUNS = 10;

export class RevisionError extends Error {}

export type RevisionProposalInput = {
  kind: RevisionProposalKind;
  /** Skill or Routine id for those kinds; must be absent for `soul`. */
  targetId?: string | null;
  proposedBody: string;
  rationale: string;
  evidenceRunIds?: string[];
};

export type RevisionProposalDTO = {
  id: string;
  employeeId: string;
  kind: RevisionProposalKind;
  targetId: string | null;
  targetLabel: string;
  baseBody: string;
  proposedBody: string;
  rationale: string;
  evidenceRunIds: string[];
  status: RevisionProposal["status"];
  errorMessage: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  reviewNote: string;
  createdAt: string;
};

function repo() {
  return AppDataSource.getRepository(RevisionProposal);
}

export function parseEvidenceRunIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function serializeRevisionProposal(row: RevisionProposal): RevisionProposalDTO {
  return {
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    baseBody: row.baseBody,
    proposedBody: row.proposedBody,
    rationale: row.rationale,
    evidenceRunIds: parseEvidenceRunIds(row.evidenceRunIdsJson),
    status: row.status,
    errorMessage: row.errorMessage,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt.toISOString(),
  };
}

type Target = {
  label: string;
  body: string;
  ownerEmployeeId: string;
  sharedRoutineId?: string;
  write: (body: string) => Promise<void>;
};

/**
 * Soul and Skills remain owned surfaces. A successful Ask AI participant may
 * suggest a same-company Routine brief, never its acceptance criteria.
 */
async function loadTarget(
  employee: AIEmployee,
  kind: RevisionProposalKind,
  targetId: string | null,
  manager: EntityManager = AppDataSource.manager,
): Promise<Target> {
  if (kind === "soul") {
    if (targetId) throw new RevisionError("A soul proposal names no target — it is your own");
    return {
      label: "Soul",
      body: employee.soulBody,
      ownerEmployeeId: employee.id,
      write: async (body) => {
        const changed = await manager
          .getRepository(AIEmployee)
          .update(
            { id: employee.id, companyId: employee.companyId, soulBody: employee.soulBody },
            { soulBody: body },
          );
        if (changed.affected !== 1) throw new RevisionError("The target changed during review");
      },
    };
  }
  if (!targetId || !UUID_RE.test(targetId)) throw new RevisionError("Target not found");
  if (kind === "skill") {
    const skill = await manager.getRepository(Skill).findOneBy({
      id: targetId,
      employeeId: employee.id,
    });
    if (!skill) throw new RevisionError("That skill is not yours to revise");
    return {
      label: skill.name,
      body: skill.body,
      ownerEmployeeId: employee.id,
      write: async (body) => {
        const changed = await manager
          .getRepository(Skill)
          .update({ id: skill.id, employeeId: employee.id, body: skill.body }, { body });
        if (changed.affected !== 1) throw new RevisionError("The target changed during review");
      },
    };
  }
  const routine = await manager.getRepository(Routine).findOne({
    where: { id: targetId },
    ...(manager.queryRunner?.isTransactionActive && AppDataSource.options.type === "postgres"
      ? { lock: { mode: "pessimistic_write" as const } }
      : {}),
  });
  if (!routine) throw new RevisionError("That routine is not yours to revise");
  const shared = routine.employeeId !== employee.id;
  const participation =
    shared && kind === "routine_body"
      ? await findRoutineParticipation(employee.companyId, employee.id, routine.id, manager)
      : null;
  if (shared && !participation) {
    throw new RevisionError("That Routine requires your current successful Ask AI participation");
  }
  if (kind === "routine_body") {
    return {
      label: participation ? `${routine.name} (${participation.owner.name})` : routine.name,
      body: routine.body,
      ownerEmployeeId: routine.employeeId,
      ...(shared ? { sharedRoutineId: routine.id } : {}),
      write: async (body) => {
        const changed = await manager
          .getRepository(Routine)
          .update({ id: routine.id, employeeId: routine.employeeId, body: routine.body }, { body });
        if (changed.affected !== 1) throw new RevisionError("The target changed during review");
      },
    };
  }
  return {
    label: `${routine.name} — acceptance criteria`,
    body: routine.acceptanceCriteria,
    ownerEmployeeId: routine.employeeId,
    write: async (body) => {
      const changed = await manager.getRepository(Routine).update(
        {
          id: routine.id,
          employeeId: routine.employeeId,
          acceptanceCriteria: routine.acceptanceCriteria,
        },
        { acceptanceCriteria: body },
      );
      if (changed.affected !== 1) throw new RevisionError("The target changed during review");
    },
  };
}

export async function createRevisionProposal(
  companyId: string,
  employeeId: string,
  input: RevisionProposalInput,
  /** Server-authenticated provenance, never accepted from the proposal payload. */
  options: { reviewRunId?: string } = {},
): Promise<RevisionProposal> {
  const proposedBody = input.proposedBody;
  if (proposedBody.length > MAX_BODY_CHARS) {
    throw new RevisionError(`The proposed body is too long (max ${MAX_BODY_CHARS} characters)`);
  }
  // Clearing acceptance criteria is a legitimate proposal — it switches the
  // outcome check off. Every other surface must propose actual content.
  if (!proposedBody.trim() && input.kind !== "routine_criteria") {
    throw new RevisionError("The proposed body is empty");
  }
  const rationale = input.rationale.trim();
  if (!rationale)
    throw new RevisionError("Say why — the rationale is what the reviewer reads first");
  if (rationale.length > MAX_RATIONALE_CHARS) {
    throw new RevisionError(`The rationale is too long (max ${MAX_RATIONALE_CHARS} characters)`);
  }
  const suppliedEvidence = input.evidenceRunIds === undefined ? [] : input.evidenceRunIds;
  if (
    !Array.isArray(suppliedEvidence) ||
    suppliedEvidence.some((id) => typeof id !== "string" || !UUID_RE.test(id))
  ) {
    throw new RevisionError("Every evidence Run must have a valid UUID");
  }
  if (suppliedEvidence.length > MAX_EVIDENCE_RUNS) {
    throw new RevisionError(`Cite at most ${MAX_EVIDENCE_RUNS} runs`);
  }
  const evidence = suppliedEvidence.map((id) => id.toLowerCase());
  if (new Set(evidence).size !== evidence.length) {
    throw new RevisionError("Evidence Runs must be distinct");
  }
  if (
    options.reviewRunId !== undefined &&
    (typeof options.reviewRunId !== "string" || !UUID_RE.test(options.reviewRunId))
  ) {
    throw new RevisionError("Self-review requires a valid running Run");
  }
  const reviewRunId = options.reviewRunId?.toLowerCase() ?? null;

  const created = await withSerializedTransaction(async (manager) => {
    try {
      // Every creator locks the same existing employee before checking pending
      // targets or Run allowance. SQLite uses the shared transaction queue.
      const employee = await manager.getRepository(AIEmployee).findOne({
        where: { id: employeeId, companyId },
        ...(AppDataSource.options.type === "postgres"
          ? { lock: { mode: "pessimistic_write" as const } }
          : {}),
      });
      if (!employee) throw new RevisionError("Employee not found");
      const proposals = manager.getRepository(RevisionProposal);
      if (reviewRunId) {
        const review = await manager.getRepository(Run).findOneBy({
          id: reviewRunId,
          status: "running",
          finishedAt: IsNull(),
        });
        const ownReview =
          review &&
          (await manager.getRepository(Routine).existsBy({
            id: review.routineId,
            employeeId,
            selfReviewOnly: true,
          }));
        if (!ownReview)
          throw new RevisionError("Self-review requires your own running self-review Run");
        if (input.kind === "routine_criteria") {
          throw new RevisionError("Self-review cannot propose acceptance criteria changes");
        }
        if (await proposals.existsBy({ companyId, employeeId, reviewRunId })) {
          throw new RevisionError("This self-review Run has already created a proposal");
        }
      }
      const target = await loadTarget(employee, input.kind, input.targetId ?? null, manager);
      // Select only identity/timing, never load the cited transcripts. A deleted
      // Routine has no provable current owner and cannot be cited as evidence.
      const evidenceQuery = manager
        .getRepository(Run)
        .createQueryBuilder("run")
        .innerJoin(Routine, "routine", "CAST(routine.id AS text) = run.routineId")
        .select(["run.id", "run.finishedAt"])
        .where("run.id IN (:...evidence)", { evidence })
        .andWhere(
          target.sharedRoutineId
            ? "(routine.employeeId = :employeeId OR routine.id = :sharedRoutineId)"
            : "routine.employeeId = :employeeId",
          { employeeId, sharedRoutineId: target.sharedRoutineId },
        )
        .andWhere("run.status IN (:...statuses)", {
          statuses: ["completed", "failed", "timeout"],
        })
        .andWhere("run.finishedAt IS NOT NULL");
      // Automatic reflection cannot manufacture fresh evidence by citing a
      // previous reflection. Ordinary proposals keep their existing scope.
      if (reviewRunId || target.sharedRoutineId) {
        evidenceQuery.andWhere(
          "(routine.selfReviewOnly IS NULL OR routine.selfReviewOnly = :selfReviewOnly)",
          { selfReviewOnly: false },
        );
      }
      const evidenceRuns = evidence.length ? await evidenceQuery.getMany() : [];
      if (evidenceRuns.length !== evidence.length) {
        throw new RevisionError(
          "Evidence must cite your own existing finished completed, failed, or timeout Runs, or finished Runs of this exact participating Routine",
        );
      }
      if (target.body === proposedBody) {
        throw new RevisionError("The proposed body is identical to the current one");
      }
      const targetScope = {
        companyId,
        // Every participant and the owner compete for one pending brief diff.
        ...(input.kind === "routine_body" ? {} : { employeeId }),
        kind: input.kind,
        targetId: input.targetId ? input.targetId : IsNull(),
      };
      if (await proposals.existsBy({ ...targetScope, status: "pending" })) {
        throw new RevisionError(
          "A proposal for this target is already pending review — wait for a human to decide it",
        );
      }
      if (reviewRunId) {
        const rejected = await proposals.findOne({
          where: { ...targetScope, status: "rejected", baseBody: target.body, proposedBody },
          order: { decidedAt: "DESC", createdAt: "DESC", id: "DESC" },
        });
        if (rejected) {
          const priorEvidence = new Set(
            parseEvidenceRunIds(rejected.evidenceRunIdsJson).map((id) => id.toLowerCase()),
          );
          const rejectedAt = (rejected.decidedAt ?? rejected.createdAt).getTime();
          if (
            !evidenceRuns.some(
              (run) =>
                !priorEvidence.has(run.id.toLowerCase()) && run.finishedAt!.getTime() > rejectedAt,
            )
          ) {
            throw new RevisionError(
              "This revision was rejected; cite new work finished after that rejection before repeating it",
            );
          }
        }
      }
      const proposal = await proposals.save(
        proposals.create({
          companyId,
          employeeId,
          kind: input.kind,
          targetId: input.targetId ?? null,
          targetLabel: target.label,
          baseBody: target.body,
          proposedBody,
          rationale,
          evidenceRunIdsJson: JSON.stringify(evidence),
          reviewRunId,
        }),
      );
      return { proposal, employee, targetOwnerId: target.ownerEmployeeId };
    } catch (error) {
      // A normal refusal must commit the shared SQLite connection: rolling it
      // back could erase an unrelated audit write that completed while we read.
      if (error instanceof RevisionError) return error;
      throw error;
    }
  });
  if (created instanceof RevisionError) throw created;
  const notify = () =>
    notifyRevisionPending(created.proposal, created.employee, created.targetOwnerId);
  // SQLite's single connection also serves Notification.save(array), which
  // may start its own transaction. Keep that phase in the same queue so it
  // cannot overlap the next proposal's transaction and lose a notification.
  if (AppDataSource.options.type === "postgres") await notify();
  else await withSerializedTransaction(notify);
  return created.proposal;
}

async function notifyRevisionPending(
  proposal: RevisionProposal,
  employee: AIEmployee,
  targetOwnerId: string,
): Promise<void> {
  try {
    const memberships = await AppDataSource.getRepository(Membership).find({
      where: { companyId: proposal.companyId, role: In(["owner", "admin"]) },
    });
    const audience = new Set(memberships.map((m) => m.userId));
    // The employee's manager supervises this employee without needing the
    // admin role over everything else — the browser-recordings audience rule.
    const manager = await managingMemberIdForEmployee(proposal.companyId, employee.id);
    if (manager) audience.add(manager);
    if (targetOwnerId !== employee.id) {
      const targetManager = await managingMemberIdForEmployee(proposal.companyId, targetOwnerId);
      if (targetManager) audience.add(targetManager);
    }
    if (audience.size === 0) return;
    await createNotifications(
      [...audience].map((userId) => ({
        companyId: proposal.companyId,
        userId,
        kind: "revision_pending" as const,
        title: `${employee.name} proposes revising ${proposal.kind === "soul" ? "its Soul" : `"${proposal.targetLabel}"`}`,
        body: proposal.rationale.slice(0, 200),
        link: "/revisions",
        actorKind: "ai" as const,
        actorId: employee.id,
        entityKind: "revision_proposal" as const,
        entityId: proposal.id,
      })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[revisions] failed to notify proposal ${proposal.id}:`, err);
  }
}

export async function listRevisionProposals(
  companyId: string,
  opts: { status?: RevisionProposal["status"] } = {},
): Promise<RevisionProposal[]> {
  return repo().find({
    where: opts.status ? { companyId, status: opts.status } : { companyId },
    order: { createdAt: "DESC" },
  });
}

export async function getRevisionProposal(
  companyId: string,
  id: string,
): Promise<RevisionProposal | null> {
  if (!UUID_RE.test(id)) return null;
  return repo().findOneBy({ id, companyId });
}

/**
 * Apply: re-resolve the target, refuse on drift, write the body, and stamp
 * the decision — auditing the human who applied and journaling the employee
 * whose document changed, so its next prompt knows its constitution moved.
 */
export async function applyRevisionProposal(
  proposal: RevisionProposal,
  reviewer: { userId: string | null; note?: string | null },
): Promise<RevisionProposal> {
  const result = await withSerializedTransaction(async (manager) => {
    const proposals = manager.getRepository(RevisionProposal);
    const current = await proposals.findOne({
      where: { id: proposal.id, companyId: proposal.companyId },
      ...(AppDataSource.options.type === "postgres"
        ? { lock: { mode: "pessimistic_write" as const } }
        : {}),
    });
    if (!current || current.status !== "pending")
      return new RevisionError(`This proposal is already ${current?.status ?? "unavailable"}`);
    try {
      const employee = await manager.getRepository(AIEmployee).findOneBy({
        id: current.employeeId,
        companyId: current.companyId,
      });
      if (!employee) throw new RevisionError("The proposing employee no longer exists");
      const target = await loadTarget(employee, current.kind, current.targetId, manager);
      if (target.body !== current.baseBody) {
        throw new RevisionError(
          "The target changed since this was proposed. Review the live document; the employee can re-propose.",
        );
      }
      await target.write(current.proposedBody);
      current.status = "applied";
      current.errorMessage = "";
      current.decidedAt = new Date();
      current.decidedByUserId = reviewer.userId;
      current.reviewNote = reviewer.note?.trim() ?? "";
      return { saved: await proposals.save(current), targetOwnerId: target.ownerEmployeeId };
    } catch (error) {
      if (!(error instanceof RevisionError)) throw error;
      current.errorMessage = error.message;
      await proposals.save(current);
      return error;
    }
  });
  if (result instanceof RevisionError) throw result;
  await recordRevisionDecision(result.saved, reviewer.userId, result.targetOwnerId);
  return result.saved;
}

export async function rejectRevisionProposal(
  proposal: RevisionProposal,
  reviewer: { userId: string | null; note?: string | null },
): Promise<RevisionProposal> {
  const result = await withSerializedTransaction(async (manager) => {
    const proposals = manager.getRepository(RevisionProposal);
    const current = await proposals.findOne({
      where: { id: proposal.id, companyId: proposal.companyId },
      ...(AppDataSource.options.type === "postgres"
        ? { lock: { mode: "pessimistic_write" as const } }
        : {}),
    });
    if (!current || current.status !== "pending")
      return new RevisionError(`This proposal is already ${current?.status ?? "unavailable"}`);
    current.status = "rejected";
    current.decidedAt = new Date();
    current.decidedByUserId = reviewer.userId;
    current.reviewNote = reviewer.note?.trim() ?? "";
    let targetOwnerId = current.employeeId;
    if (current.kind === "routine_body" && current.targetId) {
      const routine = await manager.getRepository(Routine).findOneBy({ id: current.targetId });
      if (
        routine &&
        (await manager.getRepository(AIEmployee).existsBy({
          id: routine.employeeId,
          companyId: current.companyId,
        }))
      )
        targetOwnerId = routine.employeeId;
    }
    return { saved: await proposals.save(current), targetOwnerId };
  });
  if (result instanceof RevisionError) throw result;
  await recordRevisionDecision(result.saved, reviewer.userId, result.targetOwnerId);
  return result.saved;
}

async function recordRevisionDecision(
  proposal: RevisionProposal,
  reviewerUserId: string | null,
  targetOwnerId: string,
): Promise<void> {
  const applied = proposal.status === "applied";
  await recordAudit({
    companyId: proposal.companyId,
    actorUserId: reviewerUserId,
    action: applied ? "revision.apply" : "revision.reject",
    targetType: "revision_proposal",
    targetId: proposal.id,
    targetLabel: proposal.targetLabel,
    metadata: {
      kind: proposal.kind,
      employeeId: proposal.employeeId,
      proposerEmployeeId: proposal.employeeId,
      targetOwnerEmployeeId: targetOwnerId,
    },
  });
  try {
    const journal = AppDataSource.getRepository(JournalEntry);
    for (const employeeId of new Set([proposal.employeeId, targetOwnerId])) {
      if (
        !(await AppDataSource.getRepository(AIEmployee).existsBy({
          id: employeeId,
          companyId: proposal.companyId,
        }))
      )
        continue;
      const target = proposal.kind === "soul" ? "your Soul" : `"${proposal.targetLabel}"`;
      const subject =
        employeeId === proposal.employeeId ? "Your revision" : "A colleague's revision";
      await journal.save(
        journal.create({
          employeeId,
          kind: "system",
          title: `${subject} of ${target} was ${applied ? "applied" : "declined"}`,
          body:
            proposal.reviewNote || (applied ? "Approved as proposed." : "Declined without a note."),
          runId: null,
          routineId: null,
          authorUserId: reviewerUserId,
        }),
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[revisions] failed to journal decision of ${proposal.id}:`, err);
  }
}
