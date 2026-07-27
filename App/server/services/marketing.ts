import { In, type FindOptionsWhere } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import {
  EmployeeMarketingGrant,
  MARKETING_ACCESS_RANK,
  type MarketingAccessLevel,
} from "../db/entities/EmployeeMarketingGrant.js";
import {
  MarketingCampaign,
  type MarketingAutonomyMode,
  type MarketingCampaignObjective,
  type MarketingCampaignStatus,
} from "../db/entities/MarketingCampaign.js";
import {
  MarketingCreative,
  type MarketingCreativeFormat,
  type MarketingCreativeStatus,
} from "../db/entities/MarketingCreative.js";
import {
  MarketingExperiment,
  type MarketingExperimentStatus,
} from "../db/entities/MarketingExperiment.js";
import { MarketingPerformanceSnapshot } from "../db/entities/MarketingPerformanceSnapshot.js";

export type MarketingActor =
  | { userId: string | null; employeeId?: never }
  | { employeeId: string; userId?: never };

export class MarketingValidationError extends Error {}
export class MarketingNotFoundError extends Error {}

export type CampaignInput = {
  name: string;
  objective: MarketingCampaignObjective;
  status?: MarketingCampaignStatus;
  autonomyMode?: MarketingAutonomyMode;
  channel?: string;
  connectionId?: string | null;
  externalAccountId?: string;
  externalCampaignId?: string;
  ownerEmployeeId?: string | null;
  brief?: string;
  audience?: string;
  offer?: string;
  landingPageUrl?: string;
  successMetric?: string;
  targetValue?: string;
  dailyBudgetMinor?: number;
  currency?: string;
  startsAt?: string | null;
  endsAt?: string | null;
};

export type CreativeInput = {
  campaignId: string;
  name: string;
  format?: MarketingCreativeFormat;
  status?: MarketingCreativeStatus;
  variantGroup?: string;
  concept?: string;
  headline?: string;
  body?: string;
  callToAction?: string;
  assetUrl?: string;
  destinationUrl?: string;
  externalCreativeId?: string;
  reviewNote?: string;
};

export type ExperimentInput = {
  campaignId: string;
  name: string;
  hypothesis?: string;
  status?: MarketingExperimentStatus;
  primaryMetric?: string;
  minimumSampleSize?: string;
  creativeIds?: string[];
  winnerCreativeId?: string | null;
  decisionRationale?: string;
  startsAt?: string | null;
  endsAt?: string | null;
};

export type PerformanceInput = {
  campaignId: string;
  periodStart: string;
  periodEnd: string;
  spendMinor: number;
  impressions?: number;
  clicks?: number;
  conversions?: string;
  conversionValue?: string;
  currency: string;
  source: string;
  raw?: Record<string, unknown>;
};

function dateOrNull(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null || value === "" ? null : new Date(value);
}

function normalizeCurrency(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase();
}

function creator(actor: MarketingActor): {
  createdByUserId: string | null;
  createdByEmployeeId: string | null;
} {
  return {
    createdByUserId: "userId" in actor ? (actor.userId ?? null) : null,
    createdByEmployeeId: "employeeId" in actor ? (actor.employeeId ?? null) : null,
  };
}

function parseIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function campaignForCompany(companyId: string, id: string): Promise<MarketingCampaign> {
  const row = await AppDataSource.getRepository(MarketingCampaign).findOneBy({ id, companyId });
  if (!row) throw new MarketingNotFoundError("Marketing Campaign not found");
  return row;
}

async function assertEmployee(companyId: string, employeeId: string | null | undefined) {
  if (!employeeId) return;
  const exists = await AppDataSource.getRepository(AIEmployee).existsBy({
    id: employeeId,
    companyId,
  });
  if (!exists) throw new MarketingValidationError("AI Employee not found in this company");
}

async function assertConnection(companyId: string, connectionId: string | null | undefined) {
  if (!connectionId) return;
  const exists = await AppDataSource.getRepository(IntegrationConnection).existsBy({
    id: connectionId,
    companyId,
  });
  if (!exists) {
    throw new MarketingValidationError("Connection not found in this company");
  }
}

function assertCampaignReady(row: MarketingCampaign): void {
  if (!row.brief.trim()) {
    throw new MarketingValidationError("A Campaign needs a brief before it can be ready");
  }
  if (!row.audience.trim()) {
    throw new MarketingValidationError("A Campaign needs a target audience before it can be ready");
  }
  if (!row.successMetric.trim()) {
    throw new MarketingValidationError("A Campaign needs a success metric before it can be ready");
  }
  if (row.dailyBudgetMinor <= 0) {
    throw new MarketingValidationError(
      "A Campaign needs a positive daily budget before it can be ready",
    );
  }
  if (!row.channel.trim()) {
    throw new MarketingValidationError("A Campaign needs a channel before it can be ready");
  }
}

function assertCampaignDates(row: MarketingCampaign): void {
  if (row.startsAt && Number.isNaN(row.startsAt.getTime())) {
    throw new MarketingValidationError("Invalid Campaign start date");
  }
  if (row.endsAt && Number.isNaN(row.endsAt.getTime())) {
    throw new MarketingValidationError("Invalid Campaign end date");
  }
  if (row.startsAt && row.endsAt && row.endsAt <= row.startsAt) {
    throw new MarketingValidationError("Campaign end date must be after its start date");
  }
}

async function assertCampaignState(row: MarketingCampaign): Promise<void> {
  assertCampaignDates(row);
  await Promise.all([
    assertEmployee(row.companyId, row.ownerEmployeeId),
    assertConnection(row.companyId, row.connectionId),
  ]);
  if (row.status !== "draft" && row.status !== "archived") assertCampaignReady(row);
  if (row.status === "active" && !row.externalCampaignId.trim()) {
    throw new MarketingValidationError(
      "Link the live platform Campaign id before marking it active",
    );
  }
  if (row.autonomyMode === "autonomous" && !row.ownerEmployeeId) {
    throw new MarketingValidationError("Autonomous mode needs an owning AI Employee");
  }
}

export async function listMarketingCampaigns(
  companyId: string,
  filters: {
    status?: MarketingCampaignStatus;
    ownerEmployeeId?: string;
    channel?: string;
    includeArchived?: boolean;
  } = {},
): Promise<MarketingCampaign[]> {
  const where: FindOptionsWhere<MarketingCampaign> = { companyId };
  if (filters.status) where.status = filters.status;
  else if (!filters.includeArchived) where.status = In([
    "draft",
    "ready",
    "active",
    "paused",
    "completed",
  ]);
  if (filters.ownerEmployeeId) where.ownerEmployeeId = filters.ownerEmployeeId;
  if (filters.channel) where.channel = filters.channel;
  return AppDataSource.getRepository(MarketingCampaign).find({
    where,
    order: { updatedAt: "DESC" },
  });
}

export async function getMarketingCampaign(companyId: string, id: string) {
  const campaign = await campaignForCompany(companyId, id);
  const [creatives, experiments, snapshots] = await Promise.all([
    AppDataSource.getRepository(MarketingCreative).find({
      where: { companyId, campaignId: id },
      order: { createdAt: "ASC" },
    }),
    AppDataSource.getRepository(MarketingExperiment).find({
      where: { companyId, campaignId: id },
      order: { createdAt: "DESC" },
    }),
    AppDataSource.getRepository(MarketingPerformanceSnapshot).find({
      where: { companyId, campaignId: id },
      order: { periodEnd: "DESC" },
      take: 90,
    }),
  ]);
  return {
    campaign,
    creatives,
    experiments: experiments.map((row) => ({ ...row, creativeIds: parseIds(row.creativeIdsJson) })),
    snapshots,
  };
}

export async function createMarketingCampaign(
  companyId: string,
  input: CampaignInput,
  actor: MarketingActor,
): Promise<MarketingCampaign> {
  await assertEmployee(companyId, input.ownerEmployeeId);
  const repo = AppDataSource.getRepository(MarketingCampaign);
  const row = repo.create({
    companyId,
    name: input.name.trim(),
    objective: input.objective,
    status: input.status ?? "draft",
    autonomyMode: input.autonomyMode ?? "observe",
    channel: input.channel?.trim() ?? "",
    connectionId: input.connectionId ?? null,
    externalAccountId: input.externalAccountId?.trim() ?? "",
    externalCampaignId: input.externalCampaignId?.trim() ?? "",
    ownerEmployeeId: input.ownerEmployeeId ?? null,
    brief: input.brief?.trim() ?? "",
    audience: input.audience?.trim() ?? "",
    offer: input.offer?.trim() ?? "",
    landingPageUrl: input.landingPageUrl?.trim() ?? "",
    successMetric: input.successMetric?.trim() || "conversions",
    targetValue: input.targetValue?.trim() ?? "",
    dailyBudgetMinor: input.dailyBudgetMinor ?? 0,
    currency: normalizeCurrency(input.currency) || "USD",
    startsAt: dateOrNull(input.startsAt) ?? null,
    endsAt: dateOrNull(input.endsAt) ?? null,
    ...creator(actor),
  });
  await assertCampaignState(row);
  return repo.save(row);
}

export async function updateMarketingCampaign(
  companyId: string,
  id: string,
  patch: Partial<CampaignInput>,
): Promise<MarketingCampaign> {
  const repo = AppDataSource.getRepository(MarketingCampaign);
  const row = await campaignForCompany(companyId, id);
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.objective !== undefined) row.objective = patch.objective;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.autonomyMode !== undefined) row.autonomyMode = patch.autonomyMode;
  if (patch.channel !== undefined) row.channel = patch.channel.trim();
  if (patch.connectionId !== undefined) row.connectionId = patch.connectionId;
  if (patch.externalAccountId !== undefined) row.externalAccountId = patch.externalAccountId.trim();
  if (patch.externalCampaignId !== undefined) {
    row.externalCampaignId = patch.externalCampaignId.trim();
  }
  if (patch.ownerEmployeeId !== undefined) row.ownerEmployeeId = patch.ownerEmployeeId;
  if (patch.brief !== undefined) row.brief = patch.brief.trim();
  if (patch.audience !== undefined) row.audience = patch.audience.trim();
  if (patch.offer !== undefined) row.offer = patch.offer.trim();
  if (patch.landingPageUrl !== undefined) row.landingPageUrl = patch.landingPageUrl.trim();
  if (patch.successMetric !== undefined) row.successMetric = patch.successMetric.trim();
  if (patch.targetValue !== undefined) row.targetValue = patch.targetValue.trim();
  if (patch.dailyBudgetMinor !== undefined) row.dailyBudgetMinor = patch.dailyBudgetMinor;
  if (patch.currency !== undefined) row.currency = normalizeCurrency(patch.currency) ?? row.currency;
  const startsAt = dateOrNull(patch.startsAt);
  if (startsAt !== undefined) row.startsAt = startsAt;
  const endsAt = dateOrNull(patch.endsAt);
  if (endsAt !== undefined) row.endsAt = endsAt;
  await assertCampaignState(row);
  return repo.save(row);
}

export async function listMarketingCreatives(
  companyId: string,
  campaignId?: string,
): Promise<MarketingCreative[]> {
  return AppDataSource.getRepository(MarketingCreative).find({
    where: campaignId ? { companyId, campaignId } : { companyId },
    order: { updatedAt: "DESC" },
  });
}

async function assertCreativeCampaign(companyId: string, campaignId: string): Promise<void> {
  await campaignForCompany(companyId, campaignId);
}

export async function createMarketingCreative(
  companyId: string,
  input: CreativeInput,
  actor: MarketingActor,
): Promise<MarketingCreative> {
  await assertCreativeCampaign(companyId, input.campaignId);
  const repo = AppDataSource.getRepository(MarketingCreative);
  return repo.save(
    repo.create({
      companyId,
      campaignId: input.campaignId,
      name: input.name.trim(),
      format: input.format ?? "text",
      status: input.status ?? "draft",
      variantGroup: input.variantGroup?.trim() ?? "",
      concept: input.concept?.trim() ?? "",
      headline: input.headline?.trim() ?? "",
      body: input.body?.trim() ?? "",
      callToAction: input.callToAction?.trim() ?? "",
      assetUrl: input.assetUrl?.trim() ?? "",
      destinationUrl: input.destinationUrl?.trim() ?? "",
      externalCreativeId: input.externalCreativeId?.trim() ?? "",
      reviewNote: input.reviewNote?.trim() ?? "",
      ...creator(actor),
    }),
  );
}

export async function updateMarketingCreative(
  companyId: string,
  id: string,
  patch: Partial<CreativeInput>,
): Promise<MarketingCreative> {
  const repo = AppDataSource.getRepository(MarketingCreative);
  const row = await repo.findOneBy({ id, companyId });
  if (!row) throw new MarketingNotFoundError("Marketing Creative not found");
  if (patch.campaignId !== undefined) {
    await assertCreativeCampaign(companyId, patch.campaignId);
    row.campaignId = patch.campaignId;
  }
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.format !== undefined) row.format = patch.format;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.variantGroup !== undefined) row.variantGroup = patch.variantGroup.trim();
  if (patch.concept !== undefined) row.concept = patch.concept.trim();
  if (patch.headline !== undefined) row.headline = patch.headline.trim();
  if (patch.body !== undefined) row.body = patch.body.trim();
  if (patch.callToAction !== undefined) row.callToAction = patch.callToAction.trim();
  if (patch.assetUrl !== undefined) row.assetUrl = patch.assetUrl.trim();
  if (patch.destinationUrl !== undefined) row.destinationUrl = patch.destinationUrl.trim();
  if (patch.externalCreativeId !== undefined) row.externalCreativeId = patch.externalCreativeId.trim();
  if (patch.reviewNote !== undefined) row.reviewNote = patch.reviewNote.trim();
  return repo.save(row);
}

export async function listMarketingExperiments(
  companyId: string,
  campaignId?: string,
): Promise<Array<MarketingExperiment & { creativeIds: string[] }>> {
  const rows = await AppDataSource.getRepository(MarketingExperiment).find({
    where: campaignId ? { companyId, campaignId } : { companyId },
    order: { updatedAt: "DESC" },
  });
  return rows.map((row) => Object.assign(row, { creativeIds: parseIds(row.creativeIdsJson) }));
}

async function assertExperimentCreatives(
  companyId: string,
  campaignId: string,
  creativeIds: string[],
): Promise<void> {
  if (creativeIds.length < 2) {
    throw new MarketingValidationError(
      "An Experiment needs at least two Creative variants",
    );
  }
  if (new Set(creativeIds).size !== creativeIds.length) {
    throw new MarketingValidationError("Experiment Creative variants must be unique");
  }
  const count = await AppDataSource.getRepository(MarketingCreative).countBy({
    companyId,
    campaignId,
    id: In(creativeIds),
  });
  if (count !== creativeIds.length) {
    throw new MarketingValidationError(
      "Every Experiment Creative must belong to its Campaign",
    );
  }
}

async function assertExperimentState(row: MarketingExperiment): Promise<void> {
  const ids = parseIds(row.creativeIdsJson);
  await assertCreativeCampaign(row.companyId, row.campaignId);
  await assertExperimentCreatives(row.companyId, row.campaignId, ids);
  if (row.startsAt && Number.isNaN(row.startsAt.getTime())) {
    throw new MarketingValidationError("Invalid Experiment start date");
  }
  if (row.endsAt && Number.isNaN(row.endsAt.getTime())) {
    throw new MarketingValidationError("Invalid Experiment end date");
  }
  if (row.startsAt && row.endsAt && row.endsAt <= row.startsAt) {
    throw new MarketingValidationError("Experiment end date must be after its start date");
  }
  if (row.status === "decided") {
    if (!row.winnerCreativeId || !ids.includes(row.winnerCreativeId)) {
      throw new MarketingValidationError(
        "A decided Experiment needs a winning Creative from its variants",
      );
    }
    if (!row.decisionRationale.trim()) {
      throw new MarketingValidationError("A decided Experiment needs a decision rationale");
    }
  }
}

export async function createMarketingExperiment(
  companyId: string,
  input: ExperimentInput,
  actor: MarketingActor,
): Promise<MarketingExperiment & { creativeIds: string[] }> {
  const repo = AppDataSource.getRepository(MarketingExperiment);
  const row = repo.create({
    companyId,
    campaignId: input.campaignId,
    name: input.name.trim(),
    hypothesis: input.hypothesis?.trim() ?? "",
    status: input.status ?? "draft",
    primaryMetric: input.primaryMetric?.trim() || "conversions",
    minimumSampleSize: input.minimumSampleSize?.trim() ?? "",
    creativeIdsJson: JSON.stringify(input.creativeIds ?? []),
    winnerCreativeId: input.winnerCreativeId ?? null,
    decisionRationale: input.decisionRationale?.trim() ?? "",
    startsAt: dateOrNull(input.startsAt) ?? null,
    endsAt: dateOrNull(input.endsAt) ?? null,
    ...creator(actor),
  });
  await assertExperimentState(row);
  const saved = await repo.save(row);
  return Object.assign(saved, { creativeIds: parseIds(saved.creativeIdsJson) });
}

export async function updateMarketingExperiment(
  companyId: string,
  id: string,
  patch: Partial<ExperimentInput>,
): Promise<MarketingExperiment & { creativeIds: string[] }> {
  const repo = AppDataSource.getRepository(MarketingExperiment);
  const row = await repo.findOneBy({ id, companyId });
  if (!row) throw new MarketingNotFoundError("Marketing Experiment not found");
  if (patch.campaignId !== undefined) row.campaignId = patch.campaignId;
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.hypothesis !== undefined) row.hypothesis = patch.hypothesis.trim();
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.primaryMetric !== undefined) row.primaryMetric = patch.primaryMetric.trim();
  if (patch.minimumSampleSize !== undefined) row.minimumSampleSize = patch.minimumSampleSize.trim();
  if (patch.creativeIds !== undefined) row.creativeIdsJson = JSON.stringify(patch.creativeIds);
  if (patch.winnerCreativeId !== undefined) row.winnerCreativeId = patch.winnerCreativeId;
  if (patch.decisionRationale !== undefined) row.decisionRationale = patch.decisionRationale.trim();
  const startsAt = dateOrNull(patch.startsAt);
  if (startsAt !== undefined) row.startsAt = startsAt;
  const endsAt = dateOrNull(patch.endsAt);
  if (endsAt !== undefined) row.endsAt = endsAt;
  await assertExperimentState(row);
  const saved = await repo.save(row);
  return Object.assign(saved, { creativeIds: parseIds(saved.creativeIdsJson) });
}

export async function recordMarketingPerformance(
  companyId: string,
  input: PerformanceInput,
  actor: MarketingActor,
): Promise<MarketingPerformanceSnapshot> {
  const campaign = await campaignForCompany(companyId, input.campaignId);
  const periodStart = new Date(input.periodStart);
  const periodEnd = new Date(input.periodEnd);
  if (
    Number.isNaN(periodStart.getTime()) ||
    Number.isNaN(periodEnd.getTime()) ||
    periodEnd <= periodStart
  ) {
    throw new MarketingValidationError(
      "Performance period end must be after its valid start date",
    );
  }
  if (input.currency.toUpperCase() !== campaign.currency.toUpperCase()) {
    throw new MarketingValidationError(
      `Performance currency must match the Campaign currency (${campaign.currency})`,
    );
  }
  const repo = AppDataSource.getRepository(MarketingPerformanceSnapshot);
  return repo.save(
    repo.create({
      companyId,
      campaignId: input.campaignId,
      periodStart,
      periodEnd,
      spendMinor: input.spendMinor,
      impressions: input.impressions ?? 0,
      clicks: input.clicks ?? 0,
      conversions: input.conversions ?? "0",
      conversionValue: input.conversionValue ?? "0",
      currency: input.currency.toUpperCase(),
      source: input.source.trim(),
      rawJson: JSON.stringify(input.raw ?? {}),
      recordedByEmployeeId: "employeeId" in actor ? actor.employeeId : null,
    }),
  );
}

export async function getMarketingOverview(companyId: string) {
  const [campaigns, creatives, experiments, latestSnapshots] = await Promise.all([
    listMarketingCampaigns(companyId),
    listMarketingCreatives(companyId),
    listMarketingExperiments(companyId),
    AppDataSource.getRepository(MarketingPerformanceSnapshot).find({
      where: { companyId },
      order: { periodEnd: "DESC" },
      take: 500,
    }),
  ]);
  const latestByCampaign = new Map<string, MarketingPerformanceSnapshot>();
  for (const row of latestSnapshots) {
    if (!latestByCampaign.has(row.campaignId)) latestByCampaign.set(row.campaignId, row);
  }
  const active = campaigns.filter((row) => row.status === "active");
  const latest = [...latestByCampaign.values()];
  const latestCurrencies = new Set(latest.map((row) => row.currency));
  return {
    counts: {
      campaigns: campaigns.length,
      activeCampaigns: active.length,
      creativeInReview: creatives.filter((row) => row.status === "review").length,
      runningExperiments: experiments.filter((row) => row.status === "running").length,
    },
    plannedDailyBudgetMinor: active.reduce((sum, row) => sum + row.dailyBudgetMinor, 0),
    currency:
      new Set(active.map((row) => row.currency)).size === 1 ? (active[0]?.currency ?? "USD") : null,
    latestPerformance: {
      currency:
        latestCurrencies.size === 1 ? (latest[0]?.currency ?? "USD") : null,
      spendMinor: latest.reduce((sum, row) => sum + row.spendMinor, 0),
      impressions: latest.reduce((sum, row) => sum + row.impressions, 0),
      clicks: latest.reduce((sum, row) => sum + row.clicks, 0),
      conversions: latest.reduce((sum, row) => sum + Number(row.conversions || 0), 0),
    },
    campaigns,
  };
}

export async function getMarketingGrant(
  employeeId: string,
): Promise<EmployeeMarketingGrant | null> {
  return AppDataSource.getRepository(EmployeeMarketingGrant).findOneBy({ employeeId });
}

export async function hasMarketingAccess(
  employeeId: string,
  required: MarketingAccessLevel,
): Promise<boolean> {
  const grant = await getMarketingGrant(employeeId);
  return Boolean(grant && MARKETING_ACCESS_RANK[grant.accessLevel] >= MARKETING_ACCESS_RANK[required]);
}

export async function listMarketingGrants(companyId: string) {
  const [grants, employees] = await Promise.all([
    AppDataSource.getRepository(EmployeeMarketingGrant).find({
      where: { companyId },
      order: { createdAt: "ASC" },
    }),
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId },
      order: { name: "ASC" },
    }),
  ]);
  const granted = new Map(grants.map((row) => [row.employeeId, row]));
  return employees.map((employee) => ({
    employee: {
      id: employee.id,
      name: employee.name,
      slug: employee.slug,
      role: employee.role,
      avatarKey: employee.avatarKey,
    },
    grant: granted.get(employee.id) ?? null,
  }));
}

export async function upsertMarketingGrant(
  companyId: string,
  employeeId: string,
  accessLevel: MarketingAccessLevel,
): Promise<EmployeeMarketingGrant> {
  await assertEmployee(companyId, employeeId);
  const repo = AppDataSource.getRepository(EmployeeMarketingGrant);
  const existing = await repo.findOneBy({ employeeId });
  if (existing) {
    existing.companyId = companyId;
    existing.accessLevel = accessLevel;
    return repo.save(existing);
  }
  return repo.save(repo.create({ companyId, employeeId, accessLevel }));
}

export async function deleteMarketingGrant(
  companyId: string,
  id: string,
): Promise<boolean> {
  const row = await AppDataSource.getRepository(EmployeeMarketingGrant).findOneBy({
    id,
    companyId,
  });
  if (!row) return false;
  await AppDataSource.getRepository(EmployeeMarketingGrant).delete({ id });
  return true;
}

const ACCESS_COPY: Record<MarketingAccessLevel, string> = {
  read: "You can read Campaign briefs, Creative variants, Experiments, and performance snapshots. You cannot change them.",
  write:
    "You can create and edit Campaign strategy, draft Creative, and design Experiments. You cannot mark a Campaign active, approve Creative, decide an Experiment, or record live performance.",
  operate:
    "You can operate the Marketing workspace end to end, including Campaign status, Creative approval, Experiment decisions, and performance snapshots. External platform access still requires a separate Connection Grant; every spend increase and guarded publish remains subject to that Connection's caps and Approvals.",
};

export async function composeMarketingContext(employeeId: string): Promise<string> {
  const grant = await getMarketingGrant(employeeId);
  if (!grant) return "";
  return [
    "",
    "## Marketing",
    `You have **${grant.accessLevel}** access to the company's Marketing workspace. Find its tools with \`find_tools\` (search "campaign", "creative", "experiment", or "ads").`,
    ACCESS_COPY[grant.accessLevel],
    "The Marketing Campaign is the durable strategy and measurement record. The ad platform is still the source of truth for delivery and settled spend. Read the live platform before changing a linked Campaign, then record an immutable performance snapshot so the next Routine inherits evidence rather than guesses.",
    "Never imply a Campaign is live until it has an external Campaign id. Never upload customer lists or other PII. An autonomous Campaign is allowed to act inside its policy; it is not allowed to bypass a Connection's caps, kill switch, Approval threshold, or a browser/MCP submit Approval.",
  ].join("\n");
}
