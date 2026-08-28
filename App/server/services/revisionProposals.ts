import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Membership } from "../db/entities/Membership.js";
import {
  RevisionProposal,
  type RevisionProposalKind,
} from "../db/entities/RevisionProposal.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
// The shared uuid-PK guard — see routineFolders.ts for the Postgres 22P02 story.
import { UUID_RE } from "./bases.js";
import { recordAudit } from "./audit.js";
import { createNotifications } from "./notifications.js";
import { managingMemberIdForEmployee } from "./reportingLine.js";

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
  write: (body: string) => Promise<void>;
};

/**
 * Resolve where a proposal's body lives, enforcing the self-only rule: the
 * Skill or Routine must belong to the proposing employee, and `soul` targets
 * the employee itself.
 */
async function loadTarget(
  employee: AIEmployee,
  kind: RevisionProposalKind,
  targetId: string | null,
): Promise<Target> {
  if (kind === "soul") {
    if (targetId) throw new RevisionError("A soul proposal names no target — it is your own");
    return {
      label: "Soul",
      body: employee.soulBody,
      write: async (body) => {
        employee.soulBody = body;
        await AppDataSource.getRepository(AIEmployee).save(employee);
      },
    };
  }
  if (!targetId || !UUID_RE.test(targetId)) throw new RevisionError("Target not found");
  if (kind === "skill") {
    const skill = await AppDataSource.getRepository(Skill).findOneBy({
      id: targetId,
      employeeId: employee.id,
    });
    if (!skill) throw new RevisionError("That skill is not yours to revise");
    return {
      label: skill.name,
      body: skill.body,
      write: async (body) => {
        skill.body = body;
        await AppDataSource.getRepository(Skill).save(skill);
      },
    };
  }
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: targetId,
    employeeId: employee.id,
  });
  if (!routine) throw new RevisionError("That routine is not yours to revise");
  if (kind === "routine_body") {
    return {
      label: routine.name,
      body: routine.body,
      write: async (body) => {
        routine.body = body;
        await AppDataSource.getRepository(Routine).save(routine);
      },
    };
  }
  return {
    label: `${routine.name} — acceptance criteria`,
    body: routine.acceptanceCriteria,
    write: async (body) => {
      routine.acceptanceCriteria = body;
      await AppDataSource.getRepository(Routine).save(routine);
    },
  };
}

export async function createRevisionProposal(
  companyId: string,
  employeeId: string,
  input: RevisionProposalInput,
): Promise<RevisionProposal> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new RevisionError("Employee not found");

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
  if (!rationale) throw new RevisionError("Say why — the rationale is what the reviewer reads first");
  if (rationale.length > MAX_RATIONALE_CHARS) {
    throw new RevisionError(`The rationale is too long (max ${MAX_RATIONALE_CHARS} characters)`);
  }
  const evidence = (input.evidenceRunIds ?? []).filter((id) => UUID_RE.test(id));
  if (evidence.length > MAX_EVIDENCE_RUNS) {
    throw new RevisionError(`Cite at most ${MAX_EVIDENCE_RUNS} runs`);
  }

  const target = await loadTarget(employee, input.kind, input.targetId ?? null);
  if (target.body === proposedBody) {
    throw new RevisionError("The proposed body is identical to the current one");
  }

  const duplicate = await repo().findOneBy({
    companyId,
    employeeId,
    kind: input.kind,
    targetId: input.targetId ? input.targetId : IsNull(),
    status: "pending",
  });
  if (duplicate) {
    throw new RevisionError(
      "A proposal for this target is already pending review — wait for a human to decide it",
    );
  }

  const proposal = await repo().save(
    repo().create({
      companyId,
      employeeId,
      kind: input.kind,
      targetId: input.targetId ?? null,
      targetLabel: target.label,
      baseBody: target.body,
      proposedBody,
      rationale,
      evidenceRunIdsJson: JSON.stringify(evidence),
    }),
  );
  await notifyRevisionPending(proposal, employee);
  return proposal;
}

async function notifyRevisionPending(
  proposal: RevisionProposal,
  employee: AIEmployee,
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
  if (proposal.status !== "pending") {
    throw new RevisionError(`This proposal is already ${proposal.status}`);
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: proposal.employeeId,
    companyId: proposal.companyId,
  });
  if (!employee) throw new RevisionError("The proposing employee no longer exists");

  let target: Target;
  try {
    target = await loadTarget(employee, proposal.kind, proposal.targetId);
  } catch (err) {
    if (err instanceof RevisionError) {
      proposal.errorMessage = err.message;
      await repo().save(proposal);
    }
    throw err;
  }
  if (target.body !== proposal.baseBody) {
    proposal.errorMessage =
      "The target changed since this was proposed. Review the live document; the employee can re-propose.";
    await repo().save(proposal);
    throw new RevisionError(proposal.errorMessage);
  }

  await target.write(proposal.proposedBody);
  proposal.status = "applied";
  proposal.errorMessage = "";
  proposal.decidedAt = new Date();
  proposal.decidedByUserId = reviewer.userId;
  proposal.reviewNote = reviewer.note?.trim() ?? "";
  const saved = await repo().save(proposal);

  await recordAudit({
    companyId: proposal.companyId,
    actorUserId: reviewer.userId,
    action: "revision.apply",
    targetType: "revision_proposal",
    targetId: proposal.id,
    targetLabel: proposal.targetLabel,
    metadata: { kind: proposal.kind, employeeId: proposal.employeeId },
  });
  try {
    const journal = AppDataSource.getRepository(JournalEntry);
    await journal.save(
      journal.create({
        employeeId: proposal.employeeId,
        kind: "system",
        title: `Your revision of ${proposal.kind === "soul" ? "your Soul" : `"${proposal.targetLabel}"`} was applied`,
        body: proposal.reviewNote || "Approved as proposed.",
        runId: null,
        routineId: null,
        authorUserId: reviewer.userId,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[revisions] failed to journal apply of ${proposal.id}:`, err);
  }
  return saved;
}

export async function rejectRevisionProposal(
  proposal: RevisionProposal,
  reviewer: { userId: string | null; note?: string | null },
): Promise<RevisionProposal> {
  if (proposal.status !== "pending") {
    throw new RevisionError(`This proposal is already ${proposal.status}`);
  }
  proposal.status = "rejected";
  proposal.decidedAt = new Date();
  proposal.decidedByUserId = reviewer.userId;
  proposal.reviewNote = reviewer.note?.trim() ?? "";
  const saved = await repo().save(proposal);
  await recordAudit({
    companyId: proposal.companyId,
    actorUserId: reviewer.userId,
    action: "revision.reject",
    targetType: "revision_proposal",
    targetId: proposal.id,
    targetLabel: proposal.targetLabel,
    metadata: { kind: proposal.kind, employeeId: proposal.employeeId },
  });
  try {
    const journal = AppDataSource.getRepository(JournalEntry);
    await journal.save(
      journal.create({
        employeeId: proposal.employeeId,
        kind: "system",
        title: `Your revision of ${proposal.kind === "soul" ? "your Soul" : `"${proposal.targetLabel}"`} was declined`,
        body: proposal.reviewNote || "Declined without a note.",
        runId: null,
        routineId: null,
        authorUserId: reviewer.userId,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[revisions] failed to journal rejection of ${proposal.id}:`, err);
  }
  return saved;
}
