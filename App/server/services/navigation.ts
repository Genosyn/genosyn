import { In, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { FinanceProposal } from "../db/entities/FinanceProposal.js";
import { Initiative } from "../db/entities/Initiative.js";
import type { FinanceAccess, Role } from "../db/entities/Membership.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { Todo } from "../db/entities/Todo.js";
import type { WaitingElsewhere } from "../../shared/navigation.js";
import { financeAccessFor } from "../middleware/financeAccess.js";
import { listAccessibleProjectIds } from "./projects.js";

/**
 * What waits on one person in the queues the Decision stack links to, so a
 * single place says everything that needs them (`shared/navigation.ts`).
 * Every read is a count on a `companyId`-leading index and never reads a row
 * body.
 */

/** The Approval kinds the Decision stack draws as its own rows. */
const STACK_APPROVAL_KINDS = ["proactive_work", "mail_send"];

/**
 * What waits on this person in the queues the Decision stack links to. Each
 * count follows who may act on that queue: Approvals, Revisions, and
 * Initiatives are decided by owners and admins; a Finance proposal is applied
 * with full Finance access; a todo review belongs to the Member it names.
 */
export async function countWaitingElsewhere(args: {
  companyId: string;
  userId: string;
  role: Role;
  financeAccess: FinanceAccess | undefined;
}): Promise<WaitingElsewhere> {
  const { companyId, userId, role } = args;
  const isAdmin = role === "owner" || role === "admin";
  const financeFull = financeAccessFor(role, args.financeAccess) === "full";

  const projectIds = [
    ...(await listAccessibleProjectIds(companyId, { kind: "user", id: userId, role })),
  ];
  const todoReviews = projectIds.length
    ? await AppDataSource.getRepository(Todo).count({
        where: { projectId: In(projectIds), reviewerUserId: userId, status: "in_review" },
      })
    : 0;

  return {
    approvals: isAdmin
      ? await AppDataSource.getRepository(Approval).count({
          where: { companyId, status: "pending", kind: Not(In(STACK_APPROVAL_KINDS)) },
        })
      : null,
    revisions: isAdmin
      ? await AppDataSource.getRepository(RevisionProposal).count({
          where: { companyId, status: "pending" },
        })
      : null,
    initiatives: isAdmin
      ? await AppDataSource.getRepository(Initiative).count({
          where: { companyId, status: "pending" },
        })
      : null,
    todoReviews,
    financeProposals: financeFull
      ? await AppDataSource.getRepository(FinanceProposal).count({
          where: { companyId, status: "pending" },
        })
      : null,
  };
}
