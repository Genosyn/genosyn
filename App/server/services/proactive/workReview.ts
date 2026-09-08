import { Between, In, LessThanOrEqual } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { Repository } from "../../db/entities/Repository.js";
import { RepositoryWorkSession } from "../../db/entities/RepositoryWorkSession.js";
import { RevisionProposal } from "../../db/entities/RevisionProposal.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import { RunLesson } from "../../db/entities/RunLesson.js";
import { redactSensitiveText } from "../approvalRedaction.js";
import {
  conciseWorkSummary,
  RUN_WORK_SUMMARY_MAX_CHARS,
  runWorkSummary,
} from "../runWorkSummary.js";
import { proactiveId } from "./ids.js";
import { findRoutineParticipation, listParticipatingRoutines } from "../routineParticipation.js";

export const OWN_WORK_REVIEW_LIMIT = 20;
const TEXT_LIMIT = 400;
const LABEL_LIMIT = 120;
const EVIDENCE_LIMIT = 10;
const FINISHED_RUN_STATUSES = ["completed", "failed", "timeout"];
const uuid = z.string().uuid();

export class OwnWorkReviewError extends Error {
  readonly status = 404;
}

function section<T>(rows: T[]) {
  return {
    items: rows.slice(0, OWN_WORK_REVIEW_LIMIT),
    limit: OWN_WORK_REVIEW_LIMIT,
    truncated: rows.length > OWN_WORK_REVIEW_LIMIT,
  };
}

function textPreview(
  value: string | null,
  field: string,
  truncatedFields: string[],
  cap = TEXT_LIMIT,
) {
  if (value === null) return null;
  // As with Run work summaries, normalize inline Markdown first so a closing
  // emphasis marker is not mistaken for the credential's value. Redact before
  // clipping, including credentials crossing the excerpt boundary.
  const safe = redactSensitiveText(
    value
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(?<!\w)_([^\n]+?)_(?!\w)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1"),
  ).trim();
  if (safe.length <= cap) return safe;
  truncatedFields.push(field);
  return (
    safe
      .slice(0, cap - 1)
      .replace(/[\uD800-\uDBFF]$/, "")
      .trimEnd() + "…"
  );
}

function evidenceIds(raw: string): { ids: string[]; limited: boolean } {
  // Normal proposals have at most ten UUIDs. Corrupt historical JSON must not
  // turn a small review into an unbounded lookup or reveal arbitrary strings.
  if (raw.length > 4096) return { ids: [], limited: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ids: [], limited: true };
    const valid = [...new Set(parsed.filter((id): id is string => uuid.safeParse(id).success))];
    return {
      ids: valid.slice(0, EVIDENCE_LIMIT),
      limited: valid.length !== parsed.length || valid.length > EVIDENCE_LIMIT,
    };
  } catch {
    return { ids: [], limited: true };
  }
}

/**
 * Read-only evidence for improving this employee's own work. Text is untrusted
 * historical evidence, never authority or proof that an outcome was achieved.
 * Pending proposals span all ages; other sources use the last thirty days.
 * Repository review decisions update the session rather than its finish time,
 * so their window uses updatedAt. All source limits apply after access filters.
 * The stable review Routine and every Routine marked selfReviewOnly are
 * excluded from Runs, Lessons, and cited revision evidence before applying limits.
 */
export async function getOwnWorkReview(
  companyId: string,
  employeeId: string,
  { now = new Date() }: { now?: Date } = {},
) {
  if (
    !uuid.safeParse(employeeId).success ||
    !(await AppDataSource.getRepository(AIEmployee).existsBy({
      id: employeeId,
      companyId,
    }))
  )
    throw new OwnWorkReviewError("AI Employee not found");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid review time");
  const until = new Date(now);
  const since = new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
  const reviewRoutineId = proactiveId(companyId, employeeId, "improve-own-work", null);
  const take = OWN_WORK_REVIEW_LIMIT + 1;
  const participations = await listParticipatingRoutines(companyId, employeeId);
  const participatingIds = participations.items.map((item) => item.routine.id);
  const participatingRuns = participatingIds.length
    ? await AppDataSource.getRepository(Run).find({
        where: {
          routineId: In(participatingIds),
          status: In(FINISHED_RUN_STATUSES),
          finishedAt: Between(since, until),
        },
        order: { finishedAt: "DESC", id: "DESC" },
        take,
      })
    : [];
  const sharedPending = participatingIds.length
    ? await AppDataSource.getRepository(RevisionProposal).find({
        where: {
          companyId,
          kind: "routine_body",
          targetId: In(participatingIds),
          status: "pending",
        },
        select: ["id", "targetId"],
        order: { createdAt: "DESC", id: "DESC" },
        take: OWN_WORK_REVIEW_LIMIT,
      })
    : [];

  const [runs, lessons, pending, decided, mailHandovers, sessions] = await Promise.all([
    AppDataSource.getRepository(Run)
      .createQueryBuilder("run")
      .innerJoin(
        Routine,
        "routine",
        "CAST(routine.id AS text) = run.routineId AND routine.employeeId = :employeeId",
        { employeeId },
      )
      .where("run.routineId != :reviewRoutineId", { reviewRoutineId })
      .andWhere("(routine.selfReviewOnly IS NULL OR routine.selfReviewOnly = :selfReviewOnly)", {
        selfReviewOnly: false,
      })
      .andWhere("run.status IN (:...statuses)", { statuses: FINISHED_RUN_STATUSES })
      .andWhere("run.finishedAt BETWEEN :since AND :until", { since, until })
      .orderBy("run.finishedAt", "DESC")
      .addOrderBy("run.id", "DESC")
      .take(take)
      .getMany(),
    AppDataSource.getRepository(RunLesson)
      .createQueryBuilder("lesson")
      .innerJoin(
        Routine,
        "routine",
        "CAST(routine.id AS text) = lesson.routineId AND routine.employeeId = :employeeId",
        { employeeId },
      )
      .innerJoin(
        Run,
        "run",
        "CAST(run.id AS text) = lesson.runId AND run.routineId = CAST(routine.id AS text)",
      )
      .where("lesson.companyId = :companyId AND lesson.employeeId = :employeeId", {
        companyId,
        employeeId,
      })
      .andWhere("lesson.dismissedAt IS NULL")
      .andWhere("lesson.createdAt BETWEEN :since AND :until", { since, until })
      .andWhere("routine.id != :reviewRoutineId", { reviewRoutineId })
      .andWhere("(routine.selfReviewOnly IS NULL OR routine.selfReviewOnly = :selfReviewOnly)", {
        selfReviewOnly: false,
      })
      .andWhere("run.status IN (:...statuses)", { statuses: FINISHED_RUN_STATUSES })
      .andWhere("run.finishedAt IS NOT NULL AND run.finishedAt <= :until", { until })
      .orderBy("lesson.createdAt", "DESC")
      .addOrderBy("lesson.id", "DESC")
      .take(take)
      .getMany(),
    AppDataSource.getRepository(RevisionProposal).find({
      where: { companyId, employeeId, status: "pending", createdAt: LessThanOrEqual(until) },
      order: { createdAt: "DESC", id: "DESC" },
      take,
    }),
    AppDataSource.getRepository(RevisionProposal).find({
      where: {
        companyId,
        employeeId,
        status: In(["applied", "rejected"]),
        decidedAt: Between(since, until),
      },
      order: { decidedAt: "DESC", id: "DESC" },
      take,
    }),
    AppDataSource.getRepository(MailHandover)
      .createQueryBuilder("handover")
      .innerJoin(
        MailAccount,
        "account",
        "CAST(account.id AS text) = handover.accountId AND account.companyId = :companyId",
        { companyId },
      )
      .innerJoin(
        EmployeeMailAccountGrant,
        "mailGrant",
        "mailGrant.accountId = CAST(account.id AS text) AND mailGrant.employeeId = :employeeId AND mailGrant.accessLevel IN (:...mailLevels)",
        { employeeId, mailLevels: ["read", "draft", "send"] },
      )
      .where("handover.companyId = :companyId AND handover.employeeId = :employeeId", {
        companyId,
        employeeId,
      })
      .andWhere("handover.status IN (:...statuses)", { statuses: ["completed", "failed"] })
      .andWhere("handover.finishedAt BETWEEN :since AND :until", { since, until })
      .orderBy("handover.finishedAt", "DESC")
      .addOrderBy("handover.id", "DESC")
      .take(take)
      .getMany(),
    AppDataSource.getRepository(RepositoryWorkSession)
      .createQueryBuilder("session")
      .innerJoin(
        Repository,
        "repository",
        "CAST(repository.id AS text) = session.repositoryId AND repository.companyId = :companyId",
        { companyId },
      )
      .innerJoin(
        EmployeeRepositoryGrant,
        "repositoryGrant",
        "repositoryGrant.repositoryId = CAST(repository.id AS text) AND repositoryGrant.employeeId = :employeeId AND repositoryGrant.accessLevel IN (:...repositoryLevels)",
        { employeeId, repositoryLevels: ["read", "write"] },
      )
      .where("session.companyId = :companyId AND session.employeeId = :employeeId", {
        companyId,
        employeeId,
      })
      .andWhere("session.status IN (:...statuses)", {
        statuses: ["ready", "empty", "proposed", "published", "discarded", "failed"],
      })
      .andWhere("session.updatedAt BETWEEN :since AND :until", { since, until })
      .orderBy("session.updatedAt", "DESC")
      .addOrderBy("session.id", "DESC")
      .take(take)
      .getMany(),
  ]);

  const proposals = [
    ...pending.slice(0, OWN_WORK_REVIEW_LIMIT),
    ...decided.slice(0, OWN_WORK_REVIEW_LIMIT),
  ];
  const parsedEvidence = new Map(
    proposals.map((row) => [row.id, evidenceIds(row.evidenceRunIdsJson)]),
  );
  const referencedIds = [...new Set([...parsedEvidence.values()].flatMap((value) => value.ids))];
  const proposalTargetIds = [
    ...new Set(
      proposals
        .filter((row) => row.kind === "routine_body" && row.targetId)
        .map((row) => row.targetId!),
    ),
  ];
  const currentTargets = await Promise.all(
    proposalTargetIds.map((id) => findRoutineParticipation(companyId, employeeId, id)),
  );
  const sharedTargetIds = currentTargets
    .filter((item) => item !== null)
    .map((item) => item.routine.id);
  const ownEvidence = referencedIds.length
    ? await AppDataSource.getRepository(Run)
        .createQueryBuilder("run")
        .select(["run.id", "run.routineId"])
        .innerJoin(Routine, "routine", "CAST(routine.id AS text) = run.routineId")
        .where("run.id IN (:...ids)", { ids: referencedIds })
        .andWhere(
          sharedTargetIds.length
            ? "(routine.employeeId = :employeeId OR routine.id IN (:...sharedTargetIds))"
            : "routine.employeeId = :employeeId",
          { employeeId, sharedTargetIds },
        )
        .andWhere("run.routineId != :reviewRoutineId", { reviewRoutineId })
        .andWhere("(routine.selfReviewOnly IS NULL OR routine.selfReviewOnly = :selfReviewOnly)", {
          selfReviewOnly: false,
        })
        .andWhere("run.status IN (:...statuses)", { statuses: FINISHED_RUN_STATUSES })
        .andWhere("run.finishedAt IS NOT NULL AND run.finishedAt <= :until", { until })
        .getMany()
    : [];
  const evidenceRoutineIds = new Map(ownEvidence.map((row) => [row.id, row.routineId]));
  const sharedEvidenceTargets = new Set(sharedTargetIds);
  const evidenceRoutineList = [...new Set(ownEvidence.map((row) => row.routineId))];
  const ownRoutineIds = new Set(
    (evidenceRoutineList.length
      ? await AppDataSource.getRepository(Routine).find({
          where: { employeeId, id: In(evidenceRoutineList) },
          select: ["id"],
        })
      : []
    ).map((row) => row.id),
  );
  const routineIds = [...new Set(runs.slice(0, OWN_WORK_REVIEW_LIMIT).map((run) => run.routineId))];
  const routines = routineIds.length
    ? await AppDataSource.getRepository(Routine).find({
        where: { id: In(routineIds), employeeId },
        select: ["id", "name"],
      })
    : [];
  const routineNames = new Map([
    ...routines.map((routine) => [routine.id, routine.name] as const),
    ...participations.items.map(({ routine }) => [routine.id, routine.name] as const),
  ]);

  const proposalPreview = (proposal: RevisionProposal) => {
    const truncatedFields: string[] = [];
    const parsed = parsedEvidence.get(proposal.id)!;
    const evidenceRunIds = parsed.ids.filter((id) => {
      const routineId = evidenceRoutineIds.get(id);
      return (
        routineId &&
        (ownRoutineIds.has(routineId) ||
          (proposal.kind === "routine_body" &&
            proposal.targetId === routineId &&
            sharedEvidenceTargets.has(routineId)))
      );
    });
    return {
      id: proposal.id,
      kind: proposal.kind,
      targetId: proposal.targetId,
      targetLabel: textPreview(proposal.targetLabel, "targetLabel", truncatedFields, LABEL_LIMIT),
      status: proposal.status,
      rationale: textPreview(proposal.rationale, "rationale", truncatedFields),
      reviewNote: textPreview(proposal.reviewNote, "reviewNote", truncatedFields),
      errorMessage: textPreview(proposal.errorMessage, "errorMessage", truncatedFields),
      proposedBodyExcerpt: textPreview(
        proposal.proposedBody,
        "proposedBodyExcerpt",
        truncatedFields,
      ),
      evidenceRunIds,
      evidenceLimited: parsed.limited || evidenceRunIds.length !== parsed.ids.length,
      createdAt: proposal.createdAt.toISOString(),
      decidedAt: proposal.decidedAt?.toISOString() ?? null,
      truncatedFields,
    };
  };

  const runPreview = (run: Run) => {
    const truncatedFields: string[] = [];
    return {
      id: run.id,
      routineId: run.routineId,
      routineName: textPreview(
        routineNames.get(run.routineId) ?? "",
        "routineName",
        truncatedFields,
        LABEL_LIMIT,
      ),
      status: run.status,
      outcomeVerdict: run.outcomeVerdict,
      checksVerdict: run.checksVerdict,
      outcomeNote: textPreview(run.outcomeNote, "outcomeNote", truncatedFields),
      summary: runWorkSummary(run),
      summaryIsPreview: true,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      attempt: run.attempt,
      checkRemediations: run.checkRemediations,
      durationMs: Math.max(0, run.finishedAt!.getTime() - run.startedAt.getTime()),
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt!.toISOString(),
      truncatedFields,
    };
  };

  return {
    employeeId,
    window: { since: since.toISOString(), until: until.toISOString(), days: 30 },
    // Explicit IDs plus an additional flag predicate keep this explanation
    // accurate without enumerating every manually created or renamed review.
    excludedRoutineIds: [reviewRoutineId],
    excludedRoutineCriteria: { selfReviewOnly: true },
    limits: {
      perSource: OWN_WORK_REVIEW_LIMIT,
      textChars: TEXT_LIMIT,
      labelChars: LABEL_LIMIT,
      summaryChars: RUN_WORK_SUMMARY_MAX_CHARS,
      evidenceRunIds: EVIDENCE_LIMIT,
    },
    runs: {
      ...section(runs),
      items: section(runs).items.map(runPreview),
    },
    participatingRoutines: {
      limit: participations.limit,
      truncated: participations.truncated,
      items: participations.items.map(({ routine, owner, receipt }) => {
        const truncatedFields: string[] = [];
        return {
          id: routine.id,
          routineId: routine.id,
          routineName: textPreview(routine.name, "routineName", truncatedFields, LABEL_LIMIT),
          ownerEmployeeId: owner.id,
          ownerName: textPreview(owner.name, "ownerName", truncatedFields, LABEL_LIMIT),
          participationMessageId: receipt.id,
          participatedAt: receipt.createdAt.toISOString(),
          pendingRevisionId: sharedPending.find((row) => row.targetId === routine.id)?.id ?? null,
          truncatedFields,
        };
      }),
    },
    participatingRuns: {
      ...section(participatingRuns),
      items: section(participatingRuns).items.map(runPreview),
    },
    lessons: {
      ...section(lessons),
      items: section(lessons).items.map((lesson) => {
        const truncatedFields: string[] = [];
        return {
          id: lesson.id,
          routineId: lesson.routineId,
          runId: lesson.runId,
          cause: textPreview(lesson.cause, "cause", truncatedFields),
          advice: textPreview(lesson.advice, "advice", truncatedFields),
          createdAt: lesson.createdAt.toISOString(),
          truncatedFields,
        };
      }),
    },
    revisions: {
      pending: { ...section(pending), items: section(pending).items.map(proposalPreview) },
      decided: { ...section(decided), items: section(decided).items.map(proposalPreview) },
    },
    mailHandovers: {
      ...section(mailHandovers),
      items: section(mailHandovers).items.map((handover) => {
        const truncatedFields: string[] = [];
        return {
          id: handover.id,
          accountId: handover.accountId,
          threadId: handover.threadId,
          status: handover.status,
          mode: handover.mode,
          sourceKind: handover.sourceKind,
          summary: conciseWorkSummary(handover.resultSummary),
          summaryIsPreview: true,
          errorMessage: textPreview(handover.errorMessage, "errorMessage", truncatedFields),
          createdAt: handover.createdAt.toISOString(),
          startedAt: handover.startedAt?.toISOString() ?? null,
          finishedAt: handover.finishedAt!.toISOString(),
          truncatedFields,
        };
      }),
    },
    repositoryWorkSessions: {
      ...section(sessions),
      items: section(sessions).items.map((session) => {
        const truncatedFields: string[] = [];
        return {
          id: session.id,
          repositoryId: session.repositoryId,
          title: textPreview(session.title, "title", truncatedFields, LABEL_LIMIT),
          status: session.status,
          summary: conciseWorkSummary(session.reply),
          summaryIsPreview: true,
          error: textPreview(session.error, "error", truncatedFields),
          turnCount: session.turnCount,
          filesChanged: session.filesChanged,
          insertions: session.insertions,
          deletions: session.deletions,
          createdAt: session.createdAt.toISOString(),
          finishedAt: session.finishedAt?.toISOString() ?? null,
          updatedAt: session.updatedAt.toISOString(),
          truncatedFields,
        };
      }),
    },
  };
}
