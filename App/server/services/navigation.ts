import { In, Not, type EntityTarget, type FindOptionsWhere, type ObjectLiteral } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Base } from "../db/entities/Base.js";
import { Bill } from "../db/entities/Bill.js";
import { Budget } from "../db/entities/Budget.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import { Chart } from "../db/entities/Chart.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { Deal } from "../db/entities/Deal.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMarketingGrant } from "../db/entities/EmployeeMarketingGrant.js";
import { EmployeeRecruitingGrant } from "../db/entities/EmployeeRecruitingGrant.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { EmployeeSigningGrant } from "../db/entities/EmployeeSigningGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { FinanceProposal } from "../db/entities/FinanceProposal.js";
import { Initiative } from "../db/entities/Initiative.js";
import { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MarketingCampaign } from "../db/entities/MarketingCampaign.js";
import { Meeting } from "../db/entities/Meeting.js";
import type { FinanceAccess, Role } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { Project } from "../db/entities/Project.js";
import { RecruitingOpening } from "../db/entities/RecruitingOpening.js";
import { Repository } from "../db/entities/Repository.js";
import { Resource } from "../db/entities/Resource.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { Routine } from "../db/entities/Routine.js";
import { Sequence } from "../db/entities/Sequence.js";
import { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import { Skill } from "../db/entities/Skill.js";
import { Todo } from "../db/entities/Todo.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { VaultSource } from "../db/entities/VaultSource.js";
import {
  USAGE_SECTIONS,
  type UsageSection,
  type WaitingElsewhere,
} from "../../shared/navigation.js";
import { financeAccessFor } from "../middleware/financeAccess.js";
import { listAccessibleProjectIds } from "./projects.js";

/**
 * Two small reads behind a simpler navigation (`shared/navigation.ts`).
 *
 * {@link listUsedSections} answers "which sections has this company started
 * using", so the ⌘K palette can list those beside the always-listed core
 * instead of every section from the first day. {@link countWaitingElsewhere}
 * counts what waits on one person in the queues the Decision stack links to,
 * so a single place says everything that needs them.
 *
 * Every probe is an existence check or a count on a `companyId`-leading index
 * (Skills and Routines go through the company's employees, on their
 * `employeeId` index), so the whole answer costs a few dozen indexed lookups
 * and never reads a row body.
 */

type Probe = { entity: EntityTarget<ObjectLiteral>; where: FindOptionsWhere<ObjectLiteral> };

async function anyExists(probes: Probe[]): Promise<boolean> {
  for (const probe of probes) {
    if (await AppDataSource.getRepository(probe.entity).exists({ where: probe.where })) return true;
  }
  return false;
}

/**
 * What counts as "in use" for each usage section: something the company made,
 * connected, or granted an AI Employee there. A Notebook alone does not count —
 * every company is given a default one — and neither does Proactive, a setup
 * page whose work shows up as Routines.
 */
function usageProbes(companyId: string, employeeIds: string[]): Record<UsageSection, Probe[]> {
  const byCompany = (entity: EntityTarget<ObjectLiteral>): Probe => ({
    entity,
    where: { companyId },
  });
  const byEmployee = (entity: EntityTarget<ObjectLiteral>): Probe[] =>
    employeeIds.length ? [{ entity, where: { employeeId: In(employeeIds) } }] : [];
  return {
    mail: [byCompany(MailAccount)],
    meetings: [byCompany(CalendarAccount), byCompany(Meeting)],
    tasks: [byCompany(Project)],
    vault: [byCompany(VaultItem), byCompany(VaultSource)],
    skills: byEmployee(Skill),
    routines: byEmployee(Routine),
    bases: [byCompany(Base)],
    notes: [byCompany(Note)],
    resources: [byCompany(Resource)],
    explore: [byCompany(Chart), byCompany(Dashboard)],
    repositories: [byCompany(Repository)],
    pipelines: [byCompany(Pipeline)],
    marketing: [byCompany(MarketingCampaign), byCompany(Budget), byCompany(EmployeeMarketingGrant)],
    revenue: [
      byCompany(Deal),
      byCompany(Contact),
      byCompany(Sequence),
      byCompany(EmployeeRevenueGrant),
    ],
    customers: [byCompany(Customer)],
    signatures: [byCompany(SignatureEnvelope), byCompany(EmployeeSigningGrant)],
    finance: [
      byCompany(Invoice),
      byCompany(Bill),
      byCompany(Estimate),
      byCompany(LedgerEntry),
      byCompany(EmployeeFinanceGrant),
    ],
    recruiting: [byCompany(RecruitingOpening), byCompany(EmployeeRecruitingGrant)],
  };
}

/** The usage sections this company has something in, in catalogue order. */
export async function listUsedSections(companyId: string): Promise<UsageSection[]> {
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: { id: true },
  });
  const probes = usageProbes(
    companyId,
    employees.map((employee) => employee.id),
  );
  const used: UsageSection[] = [];
  for (const section of USAGE_SECTIONS) {
    if (await anyExists(probes[section])) used.push(section);
  }
  return used;
}

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
