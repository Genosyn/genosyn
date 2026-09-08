import { type EntityManager } from "typeorm";
import { createHash } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { UUID_RE } from "./bases.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { proactiveId } from "./proactive/ids.js";

export class RoutineParticipationError extends Error {
  readonly status = 404;
}

/** A completed, server-recorded Ask AI answer grants suggestion/read scope only. */
export async function findRoutineParticipation(
  companyId: string,
  employeeId: string,
  routineId: string,
  manager: EntityManager = AppDataSource.manager,
) {
  if (![employeeId, routineId].every((id) => UUID_RE.test(id))) return null;
  const employee = await manager.getRepository(AIEmployee).findOneBy({ id: employeeId, companyId });
  if (!employee) return null;
  const routine = await manager.getRepository(Routine).findOneBy({ id: routineId });
  if (!routine || routine.selfReviewOnly) return null;
  const owner = await manager.getRepository(AIEmployee).findOneBy({
    id: routine.employeeId,
    companyId,
  });
  if (!owner || routine.id === proactiveId(companyId, owner.id, "improve-own-work", null))
    return null;
  const receipt = await manager.getRepository(RoutineChatMessage).findOne({
    where: { companyId, employeeId, routineId, role: "assistant", status: "ok" },
    select: ["id", "createdAt"],
    order: { createdAt: "DESC", id: "DESC" },
  });
  return receipt ? { routine, owner, receipt } : null;
}

/** No transcript content is selected. Clearing the conversation removes participation. */
export async function listParticipatingRoutines(
  companyId: string,
  employeeId: string,
  { limit = 20 }: { limit?: number } = {},
) {
  const boundedLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  if (
    !UUID_RE.test(employeeId) ||
    !(await AppDataSource.getRepository(AIEmployee).existsBy({ id: employeeId, companyId }))
  )
    throw new RoutineParticipationError("AI Employee not found");
  const rows = await AppDataSource.getRepository(RoutineChatMessage)
    .createQueryBuilder("receipt")
    .innerJoin(Routine, "routine", "CAST(routine.id AS text) = receipt.routineId")
    .innerJoin(AIEmployee, "owner", "CAST(owner.id AS text) = routine.employeeId")
    .select("receipt.routineId", "routineId")
    .addSelect("MAX(receipt.createdAt)", "participatedAt")
    .where("receipt.companyId = :companyId AND receipt.employeeId = :employeeId", {
      companyId,
      employeeId,
    })
    .andWhere("receipt.role = :role AND receipt.status = :status", {
      role: "assistant",
      status: "ok",
    })
    .andWhere("owner.companyId = :companyId AND routine.employeeId != :employeeId")
    .andWhere("(routine.selfReviewOnly IS NULL OR routine.selfReviewOnly = :selfReviewOnly)", {
      selfReviewOnly: false,
    })
    .groupBy("receipt.routineId")
    .orderBy('"participatedAt"', "DESC")
    .addOrderBy("receipt.routineId", "DESC")
    .limit(boundedLimit + 1)
    .getRawMany<{ routineId: string; participatedAt: string }>();
  const current = await Promise.all(
    rows
      .slice(0, boundedLimit)
      .map((row) => findRoutineParticipation(companyId, employeeId, row.routineId)),
  );
  return {
    items: current.filter((item) => item !== null),
    limit: boundedLimit,
    truncated: rows.length > boundedLimit,
  };
}

export async function getParticipatingRoutine(
  companyId: string,
  employeeId: string,
  routineId: string,
  { bodyOffset = 0 }: { bodyOffset?: number } = {},
) {
  const participation = await findRoutineParticipation(companyId, employeeId, routineId);
  if (!participation) throw new RoutineParticipationError("Participating Routine not found");
  const { routine, owner, receipt } = participation;
  const pending = await AppDataSource.getRepository(RevisionProposal).findOne({
    where: { companyId, kind: "routine_body", targetId: routine.id, status: "pending" },
    select: ["id"],
    order: { createdAt: "DESC", id: "DESC" },
  });
  const body = redactSensitiveText(routine.body);
  if (!Number.isSafeInteger(bodyOffset) || bodyOffset < 0 || bodyOffset > body.length)
    throw new RoutineParticipationError("The Routine body offset is outside the current document");
  let chunk = body.slice(bodyOffset, bodyOffset + 4_000).replace(/[\uD800-\uDBFF]$/, "");
  const result = {
    routineId: routine.id,
    name: redactSensitiveText(routine.name).slice(0, 120),
    ownerEmployeeId: owner.id,
    ownerName: redactSensitiveText(owner.name).slice(0, 120),
    enabled: routine.enabled,
    cronExpr: routine.cronExpr,
    body: chunk,
    bodyOffset,
    nextBodyOffset: bodyOffset + chunk.length < body.length ? bodyOffset + chunk.length : null,
    bodyTruncated: bodyOffset > 0 || chunk.length < body.length,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    participationMessageId: receipt.id,
    pendingRevisionId: pending?.id ?? null,
    participatedAt: receipt.createdAt.toISOString(),
    suggestionScope: "routine_body" as const,
  };
  // Escaped control characters can expand one character into six JSON bytes.
  // Return a complete readable chunk below the runtime's clipping threshold.
  while (JSON.stringify(result, null, 2).length > 7_500 && chunk.length) {
    chunk = chunk.slice(0, Math.floor(chunk.length * 0.8)).replace(/[\uD800-\uDBFF]$/, "");
    result.body = chunk;
    result.nextBodyOffset = bodyOffset + chunk.length;
    result.bodyTruncated = true;
  }
  return result;
}
