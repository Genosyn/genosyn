import { In, MoreThan } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import type { Company } from "../../db/entities/Company.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { RECRUITING_ACTIVE_STAGES } from "../../../shared/recruiting.js";
import { listApplications } from "./applications.js";
import { customDomainLive } from "./domains.js";
import { findRecruitingSettings, recruitingEmailSender } from "./settings.js";
import { careersBaseUrl } from "./urls.js";

/**
 * Recruiting's front page in numbers: what is open, who is waiting, who looks
 * strongest, and which part of setup is still missing. Every count is an
 * indexed `companyId` read; nothing here loads a resume.
 */
export async function recruitingOverview(company: Pick<Company, "id" | "slug" | "name">) {
  const applications = AppDataSource.getRepository(RecruitingApplication);
  const openings = AppDataSource.getRepository(RecruitingOpening);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    settings,
    openCount,
    draftCount,
    newThisWeek,
    awaitingReview,
    interviewing,
    offers,
    hiredThisMonth,
    screening,
    failedScreens,
    strongWaiting,
    recent,
    sender,
  ] = await Promise.all([
    findRecruitingSettings(company.id),
    openings.count({ where: { companyId: company.id, status: "open" } }),
    openings.count({ where: { companyId: company.id, status: "draft" } }),
    applications.count({ where: { companyId: company.id, createdAt: MoreThan(weekAgo) } }),
    applications.count({ where: { companyId: company.id, stage: "applied" } }),
    applications.count({ where: { companyId: company.id, stage: "interview" } }),
    applications.count({ where: { companyId: company.id, stage: "offer" } }),
    applications.count({
      where: { companyId: company.id, stage: "hired", stageChangedAt: MoreThan(monthAgo) },
    }),
    applications.count({ where: { companyId: company.id, screenStatus: In(["queued", "running"]) } }),
    applications.count({
      where: { companyId: company.id, screenStatus: "failed", stage: In(RECRUITING_ACTIVE_STAGES) },
    }),
    listApplications(company.id, { stage: "applied", sort: "score", minScore: 60, limit: 6 }),
    listApplications(company.id, { sort: "newest", limit: 8 }),
    recruitingEmailSender(company.id),
  ]);
  return {
    counts: {
      openOpenings: openCount,
      draftOpenings: draftCount,
      newThisWeek,
      awaitingReview,
      interviewing,
      offers,
      hiredThisMonth,
      screening,
      failedScreens,
    },
    topMatches: strongWaiting.rows,
    recent: recent.rows,
    setup: {
      siteEnabled: Boolean(settings?.siteEnabled),
      siteUrl: careersBaseUrl(company.slug, settings),
      siteVisibility: settings?.siteVisibility ?? "public",
      customDomain: settings?.customDomain ?? null,
      customDomainLive: customDomainLive(settings),
      screenerAppointed: Boolean(settings?.screenerEmployeeId),
      autoScreen: settings?.autoScreen ?? true,
      emailDelivers: sender.delivers,
      hasOpenOpening: openCount > 0,
    },
  };
}
