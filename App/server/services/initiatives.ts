import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Initiative } from "../db/entities/Initiative.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { toSlug } from "../lib/slug.js";
import { redactApprovalSummary } from "./approvalRedaction.js";
import { nextRunFor, registerRoutine } from "./cron.js";
import { assertRoutineCapacity } from "./entitlements.js";
import { recordAudit } from "./audit.js";
import { createNotifications } from "./notifications.js";
import { managingMemberIdForEmployee } from "./reportingLine.js";

/**
 * Initiatives — proactive work discovery (M54). The invariants: a proposal
 * is inert until an admin accepts; the Routine acceptance creates is exactly
 * the spec the reviewer read, validated at propose time so an accept can
 * never fail on a bad cron; and proposal volume is bounded so the queue
 * stays a signal.
 */

const PENDING_PER_EMPLOYEE_MAX = 5;
const SPEC_BODY_MAX = 20_000;

export class InitiativeError extends Error {}

export type InitiativeRoutineSpec = {
  name: string;
  cronExpr: string;
  body: string;
  acceptanceCriteria?: string;
};

export function parseRoutineSpec(raw: string): InitiativeRoutineSpec {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new InitiativeError("The routine spec is malformed");
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.name !== "string" || !p.name.trim()) {
    throw new InitiativeError("The routine spec needs a name");
  }
  if (typeof p.cronExpr !== "string" || nextRunFor(p.cronExpr) === null) {
    throw new InitiativeError("The routine spec's cron expression cannot be scheduled");
  }
  if (typeof p.body !== "string" || !p.body.trim()) {
    throw new InitiativeError("The routine spec needs a brief");
  }
  return {
    name: p.name.trim().slice(0, 80),
    cronExpr: p.cronExpr,
    body: p.body.slice(0, SPEC_BODY_MAX),
    acceptanceCriteria:
      typeof p.acceptanceCriteria === "string"
        ? p.acceptanceCriteria.slice(0, 4_000)
        : undefined,
  };
}

export async function proposeInitiative(args: {
  companyId: string;
  employeeId: string;
  title: string;
  evidence: string;
  proposal: string;
  routineSpec: InitiativeRoutineSpec;
}): Promise<Initiative> {
  // Model-written text that reaches human eyes meets the same creation-time
  // scrub Decisions apply.
  const title = (redactApprovalSummary(args.title) ?? "").trim().slice(0, 140);
  if (!title) throw new InitiativeError("An initiative needs a title");
  const evidence = (redactApprovalSummary(args.evidence) ?? "").slice(0, SPEC_BODY_MAX);
  const proposal = (redactApprovalSummary(args.proposal) ?? "").slice(0, SPEC_BODY_MAX);
  if (!evidence.trim()) {
    throw new InitiativeError("Show the evidence — what you observed is what the reviewer reads");
  }
  // Re-validate through the parser so what is stored is what accept executes.
  const spec = parseRoutineSpec(JSON.stringify(args.routineSpec));

  const repo = AppDataSource.getRepository(Initiative);
  const pending = await repo.find({
    where: { employeeId: args.employeeId, status: "pending" },
    select: { title: true },
  });
  if (pending.length >= PENDING_PER_EMPLOYEE_MAX) {
    throw new InitiativeError(
      `You already have ${pending.length} initiatives pending review — wait for those decisions`,
    );
  }
  if (pending.some((p) => p.title.toLowerCase() === title.toLowerCase())) {
    throw new InitiativeError("An initiative with this title is already pending review");
  }

  const initiative = await repo.save(
    repo.create({
      companyId: args.companyId,
      employeeId: args.employeeId,
      title,
      evidence,
      proposal,
      routineSpecJson: JSON.stringify(spec),
    }),
  );
  await notifyInitiativePending(initiative);
  return initiative;
}

async function notifyInitiativePending(initiative: Initiative): Promise<void> {
  try {
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: initiative.employeeId,
    });
    const memberships = await AppDataSource.getRepository(Membership).find({
      where: { companyId: initiative.companyId, role: In(["owner", "admin"]) },
    });
    const audience = new Set(memberships.map((m) => m.userId));
    const manager = await managingMemberIdForEmployee(initiative.companyId, initiative.employeeId);
    if (manager) audience.add(manager);
    if (audience.size === 0) return;
    await createNotifications(
      [...audience].map((userId) => ({
        companyId: initiative.companyId,
        userId,
        kind: "initiative_pending" as const,
        title: `${employee?.name ?? "An AI employee"} proposes: ${initiative.title}`,
        body: "New standing work, with the evidence attached. Accepting creates the Routine.",
        link: "/initiatives",
        actorKind: "ai" as const,
        actorId: initiative.employeeId,
        entityKind: "initiative" as const,
        entityId: initiative.id,
      })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[initiatives] failed to notify ${initiative.id}:`, err);
  }
}

export async function listInitiatives(
  companyId: string,
  status?: Initiative["status"],
): Promise<Initiative[]> {
  return AppDataSource.getRepository(Initiative).find({
    where: status ? { companyId, status } : { companyId },
    order: { createdAt: "DESC" },
    take: 200,
  });
}

export async function getInitiative(companyId: string, id: string): Promise<Initiative | null> {
  return AppDataSource.getRepository(Initiative).findOneBy({ id, companyId });
}

/**
 * Accept: claim the decision, then create exactly the Routine the reviewer
 * read — owned by the proposer, enabled, scheduled from now.
 */
export async function acceptInitiative(
  initiative: Initiative,
  reviewer: { userId: string | null; note?: string | null },
): Promise<Initiative> {
  const spec = parseRoutineSpec(initiative.routineSpecJson);
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: initiative.employeeId,
    companyId: initiative.companyId,
  });
  if (!employee) throw new InitiativeError("The proposing employee no longer exists");

  // Plan limit (M56): accepting creates a Routine — checked before the claim
  // so a refused accept leaves the initiative pending, not half-decided.
  // PlanLimitError propagates for the route to map to 402.
  await assertRoutineCapacity(initiative.companyId);

  const claim = await AppDataSource.getRepository(Initiative).update(
    { id: initiative.id, status: "pending" },
    {
      status: "accepted",
      decidedByUserId: reviewer.userId,
      decidedAt: new Date(),
      reviewNote: reviewer.note?.trim().slice(0, 2_000) ?? "",
    },
  );
  if (claim.affected !== 1) throw new InitiativeError("This initiative is already decided");

  const routineRepo = AppDataSource.getRepository(Routine);
  const routine = routineRepo.create({
    employeeId: employee.id,
    name: spec.name,
    slug: await uniqueRoutineSlug(employee.id, spec.name),
    cronExpr: spec.cronExpr,
    enabled: true,
    body: spec.body,
    acceptanceCriteria: spec.acceptanceCriteria ?? "",
  });
  registerRoutine(routine);
  await routineRepo.save(routine);
  await AppDataSource.getRepository(Initiative).update(
    { id: initiative.id },
    { createdRoutineId: routine.id },
  );

  await recordAudit({
    companyId: initiative.companyId,
    actorUserId: reviewer.userId,
    action: "initiative.accept",
    targetType: "initiative",
    targetId: initiative.id,
    targetLabel: initiative.title,
    metadata: { routineId: routine.id },
  });
  await journalToEmployee(
    employee.id,
    `Your initiative "${initiative.title}" was accepted`,
    `The routine "${routine.name}" now exists and runs on its own schedule (${routine.cronExpr}).` +
      (reviewer.note?.trim() ? ` Reviewer's note: ${reviewer.note.trim()}` : ""),
    routine.id,
  );
  return (await getInitiative(initiative.companyId, initiative.id))!;
}

export async function declineInitiative(
  initiative: Initiative,
  reviewer: { userId: string | null; note?: string | null },
): Promise<Initiative> {
  const claim = await AppDataSource.getRepository(Initiative).update(
    { id: initiative.id, status: "pending" },
    {
      status: "declined",
      decidedByUserId: reviewer.userId,
      decidedAt: new Date(),
      reviewNote: reviewer.note?.trim().slice(0, 2_000) ?? "",
    },
  );
  if (claim.affected !== 1) throw new InitiativeError("This initiative is already decided");
  await recordAudit({
    companyId: initiative.companyId,
    actorUserId: reviewer.userId,
    action: "initiative.decline",
    targetType: "initiative",
    targetId: initiative.id,
    targetLabel: initiative.title,
  });
  await journalToEmployee(
    initiative.employeeId,
    `Your initiative "${initiative.title}" was declined`,
    reviewer.note?.trim() || "Declined without a note. Do not re-propose it unchanged.",
    null,
  );
  return (await getInitiative(initiative.companyId, initiative.id))!;
}

async function uniqueRoutineSlug(employeeId: string, name: string): Promise<string> {
  const base = toSlug(name) || "routine";
  const taken = new Set(
    (
      await AppDataSource.getRepository(Routine).find({
        where: { employeeId },
        select: { slug: true },
      })
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function serializeInitiative(i: Initiative) {
  let spec: InitiativeRoutineSpec | null = null;
  try {
    spec = parseRoutineSpec(i.routineSpecJson);
  } catch {
    spec = null;
  }
  return {
    id: i.id,
    employeeId: i.employeeId,
    title: i.title,
    evidence: i.evidence,
    proposal: i.proposal,
    routineSpec: spec,
    status: i.status,
    decidedByUserId: i.decidedByUserId,
    decidedAt: i.decidedAt?.toISOString() ?? null,
    reviewNote: i.reviewNote,
    createdRoutineId: i.createdRoutineId,
    createdAt: i.createdAt.toISOString(),
  };
}

async function journalToEmployee(
  employeeId: string,
  title: string,
  body: string,
  routineId: string | null,
): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId,
        kind: "system",
        title,
        body,
        runId: null,
        routineId,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[initiatives] journal write failed", err);
  }
}
