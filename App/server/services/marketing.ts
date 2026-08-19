import { In, IsNull, LessThan, MoreThan, type FindOptionsWhere } from "typeorm";

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
  type MarketingTargetDirection,
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
import {
  MARKETING_DEFAULT_WINDOW_DAYS,
  campaignMetrics,
  deriveMetrics,
  liveReadouts,
  resolveSuccessMetric,
  totalReadouts,
  type MarketingAttention,
  type MarketingCampaignMetrics,
} from "./marketingMetrics.js";

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
  targetDirection?: MarketingTargetDirection;
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
  /** Apply the decision to the tested Creative as well as recording it. */
  promoteWinner?: boolean;
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

/**
 * Stamp "now" for a closing transition, but never at or before the start.
 *
 * An Experiment that starts and finishes inside the same millisecond is a real
 * sequence, not a zero-length window — the clock simply ran out of resolution.
 * The same is true of a start date someone set in the future and then stopped
 * early. Nudging past the start keeps `end > start` true for the stamps this
 * module writes itself, so the guard stays strict for the dates humans supply.
 */
function stampAfter(start: Date | null): Date {
  const now = new Date();
  if (start && !Number.isNaN(start.getTime()) && now <= start) {
    return new Date(start.getTime() + 1);
  }
  return now;
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

/**
 * Which state may follow which.
 *
 * The content checks below say a Campaign is *fit* to run; these say the
 * workspace agreed to run it. Without them an `operate` grant could take a
 * half-written draft straight to active and skip the review the ready state
 * exists to force — the brief would still be validated, but nobody would ever
 * have looked at it.
 */
const CAMPAIGN_TRANSITIONS: Record<MarketingCampaignStatus, MarketingCampaignStatus[]> = {
  draft: ["ready", "archived"],
  ready: ["draft", "active", "archived"],
  active: ["paused", "completed", "archived"],
  paused: ["active", "completed", "archived"],
  completed: ["active", "archived"],
  archived: ["draft"],
};

const CREATIVE_TRANSITIONS: Record<MarketingCreativeStatus, MarketingCreativeStatus[]> = {
  draft: ["review", "retired"],
  review: ["approved", "rejected", "draft"],
  approved: ["active", "retired", "draft"],
  active: ["approved", "retired"],
  rejected: ["draft"],
  retired: ["draft"],
};

const EXPERIMENT_TRANSITIONS: Record<MarketingExperimentStatus, MarketingExperimentStatus[]> = {
  draft: ["running", "stopped"],
  running: ["decided", "stopped"],
  decided: [],
  stopped: [],
};

/** Statuses a record may be created in — the rest are transitions, not origins. */
const CAMPAIGN_INITIAL_STATUSES: MarketingCampaignStatus[] = ["draft", "ready"];
const CREATIVE_INITIAL_STATUSES: MarketingCreativeStatus[] = ["draft", "review"];
const EXPERIMENT_INITIAL_STATUSES: MarketingExperimentStatus[] = ["draft", "running"];

function assertTransition<T extends string>(
  noun: string,
  transitions: Record<T, T[]>,
  from: T,
  to: T,
): void {
  if (from === to) return;
  if (!transitions[from].includes(to)) {
    const allowed = transitions[from];
    throw new MarketingValidationError(
      allowed.length
        ? `A ${noun} cannot go from ${from} to ${to}. From ${from} it can only become ${allowed.join(" or ")}.`
        : `A ${noun} that is ${from} is final and cannot become ${to}.`,
    );
  }
}

function assertInitialStatus<T extends string>(noun: string, allowed: T[], status: T): void {
  if (!allowed.includes(status)) {
    throw new MarketingValidationError(
      `A new ${noun} starts as ${allowed.join(" or ")}, not ${status}.`,
    );
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

/** Creative a Campaign is currently relying on, as opposed to merely holding. */
function liveCreativeCount(creatives: MarketingCreative[]): number {
  return creatives.filter((row) => row.status === "approved" || row.status === "active").length;
}

export async function getMarketingCampaign(companyId: string, id: string, windowDays?: number) {
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
    }),
  ]);
  const live = liveReadouts(snapshots);
  const lifetimeTotals = totalReadouts(live);
  return {
    campaign,
    creatives,
    experiments: experiments.map((row) => ({ ...row, creativeIds: parseIds(row.creativeIdsJson) })),
    // Superseded rows are returned too: seeing that a number was restated is
    // part of trusting the number that replaced it.
    snapshots: snapshots.slice(0, 90),
    snapshotCount: snapshots.length,
    metrics: campaignMetrics(campaign, live, {
      windowDays,
      liveCreativeCount: liveCreativeCount(creatives),
    }),
    lifetime: { totals: lifetimeTotals, derived: deriveMetrics(lifetimeTotals) },
  };
}

export type MarketingCampaignWithMetrics = MarketingCampaign & {
  metrics: MarketingCampaignMetrics;
};

/**
 * Campaigns with the numbers attached.
 *
 * The list is where someone decides which campaign to open, and "which one is
 * off plan" is the only question that makes that decision. Loading the window's
 * readouts once and grouping in memory keeps that from costing a query per row.
 */
export async function listMarketingCampaignsWithMetrics(
  companyId: string,
  filters: Parameters<typeof listMarketingCampaigns>[1] = {},
  windowDays: number = MARKETING_DEFAULT_WINDOW_DAYS,
): Promise<MarketingCampaignWithMetrics[]> {
  const campaigns = await listMarketingCampaigns(companyId, filters);
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((row) => row.id);
  const floor = new Date(Date.now() - windowDays * 86_400_000);
  const [snapshots, creatives] = await Promise.all([
    AppDataSource.getRepository(MarketingPerformanceSnapshot).find({
      where: {
        companyId,
        campaignId: In(ids),
        supersededAt: IsNull(),
        periodEnd: MoreThan(floor),
      },
    }),
    AppDataSource.getRepository(MarketingCreative).find({
      where: { companyId, campaignId: In(ids), status: In(["approved", "active"]) },
    }),
  ]);
  const byCampaign = new Map<string, MarketingPerformanceSnapshot[]>();
  for (const row of snapshots) {
    const bucket = byCampaign.get(row.campaignId);
    if (bucket) bucket.push(row);
    else byCampaign.set(row.campaignId, [row]);
  }
  const creativeCounts = new Map<string, number>();
  for (const row of creatives) {
    creativeCounts.set(row.campaignId, (creativeCounts.get(row.campaignId) ?? 0) + 1);
  }
  return campaigns.map((campaign) =>
    Object.assign(campaign, {
      metrics: campaignMetrics(campaign, byCampaign.get(campaign.id) ?? [], {
        windowDays,
        liveCreativeCount: creativeCounts.get(campaign.id) ?? 0,
      }),
    }),
  );
}

export async function createMarketingCampaign(
  companyId: string,
  input: CampaignInput,
  actor: MarketingActor,
): Promise<MarketingCampaign> {
  await assertEmployee(companyId, input.ownerEmployeeId);
  const status = input.status ?? "draft";
  assertInitialStatus("Campaign", CAMPAIGN_INITIAL_STATUSES, status);
  const successMetric = input.successMetric?.trim() || "conversions";
  const repo = AppDataSource.getRepository(MarketingCampaign);
  const row = repo.create({
    companyId,
    name: input.name.trim(),
    objective: input.objective,
    status,
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
    successMetric,
    targetValue: input.targetValue?.trim() ?? "",
    // A cost goal is met by going low and a return goal by going high, so the
    // sensible direction is a property of the metric. Only an explicit choice
    // overrides it.
    targetDirection:
      input.targetDirection ?? resolveSuccessMetric(successMetric)?.betterDirection ?? "at_most",
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
  if (patch.status !== undefined) {
    assertTransition("Campaign", CAMPAIGN_TRANSITIONS, row.status, patch.status);
  }
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
  if (patch.targetDirection !== undefined) row.targetDirection = patch.targetDirection;
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

/**
 * Creative only goes live under a Campaign that is itself live. The platform
 * enforces the same thing physically — an ad cannot serve inside a paused
 * campaign — so letting the workspace claim otherwise would make the one place
 * a human checks disagree with reality.
 */
async function assertCreativeCanGoLive(
  companyId: string,
  campaignId: string,
  status: MarketingCreativeStatus,
): Promise<void> {
  if (status !== "active") return;
  const campaign = await campaignForCompany(companyId, campaignId);
  if (campaign.status !== "active") {
    throw new MarketingValidationError(
      `Creative can only go live under an active Campaign; "${campaign.name}" is ${campaign.status}.`,
    );
  }
}

/** Experiments name their variants by id, so a variant cannot change Campaign. */
async function assertCreativeNotUnderTest(
  companyId: string,
  creativeId: string,
  campaignId: string,
): Promise<void> {
  const experiments = await AppDataSource.getRepository(MarketingExperiment).find({
    where: { companyId, campaignId },
  });
  const tested = experiments.find((row) => parseIds(row.creativeIdsJson).includes(creativeId));
  if (tested) {
    throw new MarketingValidationError(
      `This Creative is a variant in the Experiment "${tested.name}". Move it out of the Experiment before moving it to another Campaign.`,
    );
  }
}

export async function createMarketingCreative(
  companyId: string,
  input: CreativeInput,
  actor: MarketingActor,
): Promise<MarketingCreative> {
  await assertCreativeCampaign(companyId, input.campaignId);
  assertInitialStatus("Creative", CREATIVE_INITIAL_STATUSES, input.status ?? "draft");
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
  if (patch.status !== undefined) {
    assertTransition("Creative", CREATIVE_TRANSITIONS, row.status, patch.status);
  }
  if (patch.campaignId !== undefined && patch.campaignId !== row.campaignId) {
    await assertCreativeCampaign(companyId, patch.campaignId);
    await assertCreativeNotUnderTest(companyId, row.id, row.campaignId);
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
  await assertCreativeCanGoLive(companyId, row.campaignId, row.status);
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
  const status = input.status ?? "draft";
  assertInitialStatus("Experiment", EXPERIMENT_INITIAL_STATUSES, status);
  const row = repo.create({
    companyId,
    campaignId: input.campaignId,
    name: input.name.trim(),
    hypothesis: input.hypothesis?.trim() ?? "",
    status,
    primaryMetric: input.primaryMetric?.trim() || "conversions",
    minimumSampleSize: input.minimumSampleSize?.trim() ?? "",
    creativeIdsJson: JSON.stringify(input.creativeIds ?? []),
    winnerCreativeId: input.winnerCreativeId ?? null,
    decisionRationale: input.decisionRationale?.trim() ?? "",
    startsAt: dateOrNull(input.startsAt) ?? (status === "running" ? new Date() : null),
    endsAt: dateOrNull(input.endsAt) ?? null,
    ...creator(actor),
  });
  await assertExperimentState(row);
  const saved = await repo.save(row);
  return Object.assign(saved, { creativeIds: parseIds(saved.creativeIdsJson) });
}

/**
 * Apply an Experiment's verdict to the Creative it tested.
 *
 * A decision nobody acts on is a note. The winner goes live — or waits at
 * approved when its Campaign is not running — and the variants that were
 * serving against it retire. Rejected and already-retired variants are left
 * exactly as they are: a human said no to those, and a test result is not a
 * reason to quietly undo that.
 */
async function promoteExperimentWinner(
  row: MarketingExperiment,
  winnerCreativeId: string,
): Promise<void> {
  const creativeRepo = AppDataSource.getRepository(MarketingCreative);
  const campaign = await campaignForCompany(row.companyId, row.campaignId);
  const tested = await creativeRepo.find({
    where: { companyId: row.companyId, id: In(parseIds(row.creativeIdsJson)) },
  });
  const movable: MarketingCreativeStatus[] = ["draft", "review", "approved", "active"];
  for (const creative of tested) {
    if (!movable.includes(creative.status)) continue;
    if (creative.id === winnerCreativeId) {
      creative.status = campaign.status === "active" ? "active" : "approved";
    } else if (creative.status === "active") {
      creative.status = "retired";
    } else {
      continue;
    }
    await creativeRepo.save(creative);
  }
}

export async function updateMarketingExperiment(
  companyId: string,
  id: string,
  patch: Partial<ExperimentInput>,
): Promise<MarketingExperiment & { creativeIds: string[] }> {
  const repo = AppDataSource.getRepository(MarketingExperiment);
  const row = await repo.findOneBy({ id, companyId });
  if (!row) throw new MarketingNotFoundError("Marketing Experiment not found");
  const from = row.status;
  if (patch.status !== undefined) {
    assertTransition("Experiment", EXPERIMENT_TRANSITIONS, from, patch.status);
  }
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
  // The clock belongs to the transition, not to whoever remembered to send it.
  if (from !== "running" && row.status === "running" && !row.startsAt) row.startsAt = new Date();
  if (from !== row.status && (row.status === "decided" || row.status === "stopped") && !row.endsAt) {
    row.endsAt = stampAfter(row.startsAt);
  }
  await assertExperimentState(row);
  const saved = await repo.save(row);
  if (patch.promoteWinner && saved.status === "decided" && saved.winnerCreativeId) {
    await promoteExperimentWinner(saved, saved.winnerCreativeId);
  }
  return Object.assign(saved, { creativeIds: parseIds(saved.creativeIdsJson) });
}

/**
 * Record what the platform said about one campaign and one window.
 *
 * Two rules make the resulting ledger safe to add up. Recording the same window
 * twice supersedes the earlier row instead of adding to it, so a Routine that
 * retries after a crash cannot double the month's spend and a platform that
 * settles its numbers late can correct them without anyone editing history.
 * A window that partially overlaps a live one is refused outright, because
 * summing a daily readout and the weekly one containing it counts the same
 * money twice and no amount of later arithmetic can separate them again.
 */
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
  const clashes = await repo.find({
    where: {
      companyId,
      campaignId: input.campaignId,
      supersededAt: IsNull(),
      periodStart: LessThan(periodEnd),
      periodEnd: MoreThan(periodStart),
    },
  });
  const sameWindow = clashes.filter(
    (row) =>
      new Date(row.periodStart).getTime() === periodStart.getTime() &&
      new Date(row.periodEnd).getTime() === periodEnd.getTime(),
  );
  const partial = clashes.filter((row) => !sameWindow.includes(row));
  if (partial.length) {
    const existing = partial[0];
    throw new MarketingValidationError(
      `This period overlaps an existing readout for ${new Date(existing.periodStart).toISOString()} — ${new Date(existing.periodEnd).toISOString()}. Record the same window as the readouts already on this Campaign, or restate that exact window instead.`,
    );
  }
  const supersededAt = new Date();
  return AppDataSource.transaction(async (manager) => {
    if (sameWindow.length) {
      await manager.update(
        MarketingPerformanceSnapshot,
        { id: In(sameWindow.map((row) => row.id)) },
        { supersededAt },
      );
    }
    return manager.save(
      manager.create(MarketingPerformanceSnapshot, {
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
  });
}

/** How long a test may run undecided before it is worth chasing. */
export const MARKETING_EXPERIMENT_STALE_DAYS = 14;

export type MarketingOverviewAttention = MarketingAttention & {
  campaignId: string | null;
  campaignName: string | null;
};

/**
 * The command center.
 *
 * Everything here answers "what needs me today". The window totals are built
 * from live readouts only, and money is reported as null rather than as a
 * meaningless sum when campaigns are running in more than one currency —
 * adding dollars to euros to make a bigger number is the kind of dashboard
 * that gets believed once.
 */
export async function getMarketingOverview(
  companyId: string,
  options: { windowDays?: number } = {},
) {
  const windowDays = options.windowDays ?? MARKETING_DEFAULT_WINDOW_DAYS;
  const [campaigns, creatives, experiments] = await Promise.all([
    listMarketingCampaignsWithMetrics(companyId, {}, windowDays),
    listMarketingCreatives(companyId),
    listMarketingExperiments(companyId),
  ]);
  const active = campaigns.filter((row) => row.status === "active");
  const withSpend = campaigns.filter((row) => row.metrics.totals.snapshots > 0);
  const currencies = new Set(withSpend.map((row) => row.currency));
  const mixedCurrency = currencies.size > 1;
  const totals = withSpend.reduce(
    (sum, row) => ({
      spendMinor: sum.spendMinor + row.metrics.totals.spendMinor,
      impressions: sum.impressions + row.metrics.totals.impressions,
      clicks: sum.clicks + row.metrics.totals.clicks,
      conversions: sum.conversions + row.metrics.totals.conversions,
      conversionValueMinor: sum.conversionValueMinor + row.metrics.totals.conversionValueMinor,
    }),
    { spendMinor: 0, impressions: 0, clicks: 0, conversions: 0, conversionValueMinor: 0 },
  );
  const comparable = !mixedCurrency && withSpend.length > 0;
  // Rates and cost-per numbers over the whole portfolio. `coveredDays` is left
  // at zero deliberately: campaigns run over different stretches, so a single
  // "average daily spend" across all of them would not describe anything.
  const portfolio = deriveMetrics({
    ...totals,
    snapshots: withSpend.length,
    coveredDays: 0,
    periodStart: null,
    periodEnd: null,
  });
  const now = Date.now();
  const attention: MarketingOverviewAttention[] = campaigns.flatMap((row) =>
    row.metrics.attention.map((item) => ({
      ...item,
      campaignId: row.id,
      campaignName: row.name,
    })),
  );
  const waitingReview = creatives.filter((row) => row.status === "review").length;
  if (waitingReview > 0) {
    attention.push({
      code: "creative_waiting_review",
      severity: "info",
      message: `${waitingReview} Creative ${waitingReview === 1 ? "variant is" : "variants are"} waiting for review.`,
      campaignId: null,
      campaignName: null,
    });
  }
  for (const experiment of experiments) {
    if (experiment.status !== "running" || !experiment.startsAt) continue;
    const days = (now - new Date(experiment.startsAt).getTime()) / 86_400_000;
    if (days < MARKETING_EXPERIMENT_STALE_DAYS) continue;
    const campaign = campaigns.find((row) => row.id === experiment.campaignId);
    attention.push({
      code: "experiment_undecided",
      severity: "warn",
      message: `"${experiment.name}" has been running ${Math.floor(days)} days without a decision.`,
      campaignId: experiment.campaignId,
      campaignName: campaign?.name ?? null,
    });
  }
  attention.sort((left, right) =>
    left.severity === right.severity ? 0 : left.severity === "warn" ? -1 : 1,
  );

  return {
    windowDays,
    counts: {
      campaigns: campaigns.length,
      activeCampaigns: active.length,
      creativeInReview: waitingReview,
      runningExperiments: experiments.filter((row) => row.status === "running").length,
      needsAttention: attention.filter((row) => row.severity === "warn").length,
    },
    plannedDailyBudgetMinor: active.reduce((sum, row) => sum + row.dailyBudgetMinor, 0),
    currency:
      new Set(active.map((row) => row.currency)).size === 1 ? (active[0]?.currency ?? "USD") : null,
    performance: {
      currency: comparable ? (withSpend[0]?.currency ?? null) : null,
      mixedCurrency,
      spendMinor: comparable ? totals.spendMinor : null,
      conversionValueMinor: comparable ? totals.conversionValueMinor : null,
      impressions: totals.impressions,
      clicks: totals.clicks,
      conversions: totals.conversions,
      // Impression and click rates hold across currencies; anything with money
      // in it does not, so those go null rather than mixing units.
      ctr: portfolio.ctr,
      conversionRate: portfolio.conversionRate,
      cpcMinor: comparable ? portfolio.cpcMinor : null,
      cpmMinor: comparable ? portfolio.cpmMinor : null,
      cpaMinor: comparable ? portfolio.cpaMinor : null,
      roas: comparable ? portfolio.roas : null,
    },
    attention,
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
    "The Marketing Campaign is the durable strategy and measurement record. The ad platform is still the source of truth for delivery and settled spend. Read the live platform before changing a linked Campaign, then record a performance snapshot so the next Routine inherits evidence rather than guesses.",
    "Every Campaign readout is scored for you: `get_marketing_overview` and `get_marketing_campaign` return spend, CTR, CPC, CPA, ROAS, pacing against the planned daily budget, and whether the Campaign is meeting its target — plus an `attention` list naming what is wrong. Decide against those numbers instead of recomputing them, and cite them when you report.",
    "Record one snapshot per campaign per window, always the same window. Recording a window again restates it and supersedes the old row, which is the right way to correct a late-settling platform; a window that partly overlaps an existing one is refused, because the two would double-count the same spend.",
    "Never imply a Campaign is live until it has an external Campaign id. Never upload customer lists or other PII. An autonomous Campaign is allowed to act inside its policy; it is not allowed to bypass a Connection's caps, kill switch, Approval threshold, or a browser/MCP submit Approval.",
  ].join("\n");
}
