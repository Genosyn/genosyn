import { Between, In, LessThanOrEqual } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import {
  EmployeeFinanceGrant,
  FINANCE_ACCESS_RANK,
} from "../../db/entities/EmployeeFinanceGrant.js";
import {
  EmployeeMarketingGrant,
  MARKETING_ACCESS_RANK,
} from "../../db/entities/EmployeeMarketingGrant.js";
import {
  EmployeeRevenueGrant,
  REVENUE_ACCESS_RANK,
} from "../../db/entities/EmployeeRevenueGrant.js";
import {
  EmployeeSigningGrant,
  SIGNING_ACCESS_RANK,
} from "../../db/entities/EmployeeSigningGrant.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { LedgerEntry } from "../../db/entities/LedgerEntry.js";
import { MarketingCampaign } from "../../db/entities/MarketingCampaign.js";
import { MarketingExperiment } from "../../db/entities/MarketingExperiment.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { SignatureEnvelope } from "../../db/entities/SignatureEnvelope.js";
import { SignatureRecipient } from "../../db/entities/SignatureRecipient.js";
import { redactSensitiveText } from "../approvalRedaction.js";
import {
  PROACTIVE_SECTION_LIMIT,
  type ProactiveOpportunity,
  type ProactiveOpportunitySection,
} from "./opportunities.js";

const take = PROACTIVE_SECTION_LIMIT + 1;
const uuid = z.string().uuid();

export class CommercialOpportunitiesError extends Error {
  readonly status = 404;
}

function section(items: ProactiveOpportunity[]): ProactiveOpportunitySection {
  return {
    items: items.slice(0, PROACTIVE_SECTION_LIMIT),
    truncated: items.length > PROACTIVE_SECTION_LIMIT,
  };
}

function label(value: string, fallback: string): string {
  return redactSensitiveText(value).trim().slice(0, 120) || fallback;
}

/**
 * A bounded discovery feed, not a second commercial workflow. Explicit due
 * dates and outstanding lifecycle states supply evidence; mere age does not.
 * Read tools remain the next step and enforce current Grants again. Shared
 * Finance/signing work must be coordinated with its existing responsibility
 * owner; Revenue/Marketing cues belong to this employee. No bodies, signing
 * credentials, recipient addresses, prices, or account totals enter the feed.
 */
export async function getCommercialOpportunities(
  companyId: string,
  employeeId: string,
  now = new Date(),
): Promise<Record<string, ProactiveOpportunitySection>> {
  if (
    !uuid.safeParse(employeeId).success ||
    !(await AppDataSource.getRepository(AIEmployee).existsBy({ id: employeeId, companyId }))
  )
    throw new CommercialOpportunitiesError("AI Employee not found");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid opportunity time");

  const [finance, revenue, marketing, signing] = await Promise.all([
    AppDataSource.getRepository(EmployeeFinanceGrant).findOneBy({ companyId, employeeId }),
    AppDataSource.getRepository(EmployeeRevenueGrant).findOneBy({ companyId, employeeId }),
    AppDataSource.getRepository(EmployeeMarketingGrant).findOneBy({ companyId, employeeId }),
    AppDataSource.getRepository(EmployeeSigningGrant).findOneBy({ companyId, employeeId }),
  ]);
  const result: Record<string, ProactiveOpportunitySection> = {};

  if (finance && typeof FINANCE_ACCESS_RANK[finance.accessLevel] === "number") {
    const [transactions, estimates] = await Promise.all([
      AppDataSource.getRepository(LedgerEntry).find({
        select: { id: true, date: true },
        where: { companyId, reviewStatus: "unreviewed", date: LessThanOrEqual(now) },
        order: { date: "ASC", id: "ASC" },
        take,
      }),
      AppDataSource.getRepository(Estimate)
        .createQueryBuilder("estimate")
        .select(["estimate.id", "estimate.slug", "estimate.number", "estimate.updatedAt"])
        .innerJoin(
          Customer,
          "customer",
          "CAST(customer.id AS text) = estimate.customerId AND customer.companyId = estimate.companyId",
        )
        .where("estimate.companyId = :companyId", { companyId })
        .andWhere("estimate.status = :status", { status: "accepted" })
        .andWhere("estimate.invoiceId IS NULL AND estimate.convertedAt IS NULL")
        .andWhere("estimate.acceptedAt <= :now", { now })
        .andWhere("customer.archivedAt IS NULL")
        .orderBy("estimate.acceptedAt", "ASC")
        .addOrderBy("estimate.id", "ASC")
        .limit(take)
        .getMany(),
    ]);
    result.financeTransactions = section(
      transactions.map((row) => ({
        id: row.id,
        kind: "finance_transaction_unreviewed",
        title: `Unreviewed transaction · ${row.date.toISOString().slice(0, 10)}`,
        reason:
          finance.accessLevel === "full"
            ? "Inspect the entry before staging a category review. Final accounting approval stays with a Member."
            : "Inspect the unreviewed entry. Staging a category review requires Full Finance access; final approval stays with a Member.",
        tools: ["get_finance_transaction"],
      })),
    );
    result.acceptedEstimates = section(
      estimates.map((row) => ({
        id: row.id,
        kind: "estimate_accepted_unconverted",
        title: label(row.number, "Accepted estimate"),
        reason:
          "Accepted estimate has no conversion recorded. Inspect it and coordinate with the owner; a Member converts it in Finance. Do not create a duplicate invoice.",
        updatedAt: row.updatedAt.toISOString(),
        locator: row.slug,
        tools: ["get_estimate"],
      })),
    );
  }

  if (revenue && typeof REVENUE_ACCESS_RANK[revenue.accessLevel] === "number") {
    const rows = await AppDataSource.getRepository(Activity)
      .createQueryBuilder("activity")
      .select(["activity.id", "activity.subject", "activity.dueAt"])
      .leftJoin(
        Deal,
        "deal",
        "CAST(deal.id AS text) = activity.dealId AND deal.companyId = activity.companyId",
      )
      .leftJoin(
        Contact,
        "contact",
        "CAST(contact.id AS text) = activity.contactId AND contact.companyId = activity.companyId",
      )
      .leftJoin(
        Partnership,
        "partnership",
        "CAST(partnership.id AS text) = activity.partnershipId AND partnership.companyId = activity.companyId",
      )
      .leftJoin(
        Customer,
        "customer",
        "CAST(customer.id AS text) = COALESCE(activity.customerId, deal.customerId, partnership.customerId, contact.customerId) AND customer.companyId = activity.companyId",
      )
      .where("activity.companyId = :companyId AND activity.assignedEmployeeId = :employeeId", {
        companyId,
        employeeId,
      })
      .andWhere("activity.kind = :kind AND activity.taskStatus = :status", {
        kind: "task",
        status: "open",
      })
      .andWhere("activity.dueAt <= :now", { now })
      .andWhere(
        "(activity.dealId IS NULL OR (deal.id IS NOT NULL AND deal.archivedAt IS NULL AND deal.status = 'open'))",
      )
      .andWhere(
        "(activity.contactId IS NULL OR (contact.id IS NOT NULL AND contact.archivedAt IS NULL))",
      )
      .andWhere(
        "(activity.partnershipId IS NULL OR (partnership.id IS NOT NULL AND partnership.archivedAt IS NULL))",
      )
      .andWhere(
        "(COALESCE(activity.customerId, deal.customerId, partnership.customerId, contact.customerId) IS NULL OR (customer.id IS NOT NULL AND customer.archivedAt IS NULL))",
      )
      .orderBy("activity.dueAt", "ASC")
      .addOrderBy("activity.id", "ASC")
      .limit(take)
      .getMany();
    result.revenueFollowUps = section(
      rows.map((row) => ({
        id: row.id,
        kind: "revenue_follow_up_due",
        title: label(row.subject, "Assigned Follow-up"),
        reason:
          "Your open Follow-up is due. Read its linked records and existing work before completing or rescheduling it; sending remains separately authorized.",
        dueAt: row.dueAt!.toISOString(),
        tools: ["get_activity", "list_follow_ups"],
      })),
    );
  }

  if (marketing && typeof MARKETING_ACCESS_RANK[marketing.accessLevel] === "number") {
    const rows = await AppDataSource.getRepository(MarketingExperiment)
      .createQueryBuilder("experiment")
      .select([
        "experiment.id",
        "experiment.name",
        "experiment.campaignId",
        "experiment.endsAt",
        "experiment.updatedAt",
      ])
      .innerJoin(
        MarketingCampaign,
        "campaign",
        "CAST(campaign.id AS text) = experiment.campaignId AND campaign.companyId = experiment.companyId",
      )
      .where("experiment.companyId = :companyId AND campaign.ownerEmployeeId = :employeeId", {
        companyId,
        employeeId,
      })
      .andWhere("campaign.status = :campaignStatus AND experiment.status = :experimentStatus", {
        campaignStatus: "active",
        experimentStatus: "running",
      })
      .andWhere(
        "experiment.endsAt <= :now AND (experiment.startsAt IS NULL OR experiment.startsAt <= :now)",
        { now },
      )
      .orderBy("experiment.endsAt", "ASC")
      .addOrderBy("experiment.id", "ASC")
      .limit(take)
      .getMany();
    result.marketingExperiments = section(
      rows.map((row) => ({
        id: row.id,
        kind: "marketing_experiment_review_due",
        title: label(row.name, "Experiment review"),
        reason:
          "An Experiment on your active Campaign passed its planned end. Read measured results and sample requirements; respect Campaign autonomy and platform controls. Do not infer a winner.",
        updatedAt: row.updatedAt.toISOString(),
        dueAt: row.endsAt!.toISOString(),
        locator: row.campaignId,
        tools: ["get_marketing_campaign", "list_marketing_experiments"],
      })),
    );
  }

  if (signing && typeof SIGNING_ACCESS_RANK[signing.accessLevel] === "number") {
    const soon = new Date(now.getTime() + 7 * 86_400_000);
    const rows = await AppDataSource.getRepository(SignatureEnvelope)
      .createQueryBuilder("envelope")
      .select(["envelope.id", "envelope.title", "envelope.expiresAt", "envelope.updatedAt"])
      .where({
        companyId,
        status: In(["sent", "in_progress"]),
        expiresAt: Between(now, soon),
        sentAt: LessThanOrEqual(now),
      })
      .andWhere("envelope.expiresAt > :now", { now })
      .andWhere(
        (query) =>
          `EXISTS ${query
            .subQuery()
            .select("1")
            .from(SignatureRecipient, "recipient")
            .where(
              "recipient.envelopeId = CAST(envelope.id AS text) AND recipient.companyId = envelope.companyId",
            )
            .andWhere(
              "recipient.role = 'signer' AND recipient.status IN ('waiting', 'sent', 'viewed')",
            )
            .getQuery()}`,
      )
      .orderBy("envelope.expiresAt", "ASC")
      .addOrderBy("envelope.id", "ASC")
      .limit(take)
      .getMany();
    result.signatureExpirations = section(
      rows.map((row) => ({
        id: row.id,
        kind: "signature_expiring",
        title: label(row.title, "Signature envelope"),
        reason:
          "A sent envelope has a pending signer and expires within seven days. Inspect progress and coordinate with its owner. Reminders require separate sending authority; never sign for a recipient.",
        updatedAt: row.updatedAt.toISOString(),
        dueAt: row.expiresAt!.toISOString(),
        tools: ["get_signature_envelope"],
      })),
    );
  }
  return result;
}
