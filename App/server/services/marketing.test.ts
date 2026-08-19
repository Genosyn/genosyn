import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import {
  MarketingValidationError,
  createMarketingCampaign,
  createMarketingCreative,
  createMarketingExperiment,
  getMarketingCampaign,
  getMarketingOverview,
  hasMarketingAccess,
  listMarketingCampaignsWithMetrics,
  recordMarketingPerformance,
  updateMarketingCampaign,
  updateMarketingCreative,
  updateMarketingExperiment,
  upsertMarketingGrant,
} from "./marketing.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/** Readout windows are relative so the measured window never ages out. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function employee(companyId: string, name = "Reese") {
  return insert(AIEmployee, {
    companyId,
    name,
    slug: name.toLowerCase(),
    role: "Performance Marketer",
  });
}

describe("Marketing Campaign policy", () => {
  test("refuses incomplete ready/active/autonomous Campaigns", async () => {
    const companyId = testCompanyId();
    await assert.rejects(
      createMarketingCampaign(
        companyId,
        {
          name: "Incomplete",
          objective: "leads",
          status: "ready",
        },
        { userId: "member-1" },
      ),
      MarketingValidationError,
    );

    const owner = await employee(companyId);
    const campaign = await createMarketingCampaign(
      companyId,
      {
        name: "Founder demand",
        objective: "leads",
        channel: "google-ads",
        brief: "Reach founder-led SaaS teams with a proof-led message.",
        audience: "Founder-led SaaS companies with 10-100 employees.",
        successMetric: "qualified_leads",
        dailyBudgetMinor: 12_500,
        currency: "usd",
        ownerEmployeeId: owner.id,
        autonomyMode: "autonomous",
        status: "ready",
      },
      { userId: "member-1" },
    );
    assert.equal(campaign.currency, "USD");

    await assert.rejects(
      updateMarketingCampaign(companyId, campaign.id, { status: "active" }),
      /live platform Campaign id/,
    );
    const active = await updateMarketingCampaign(companyId, campaign.id, {
      externalCampaignId: "123456",
      status: "active",
    });
    assert.equal(active.status, "active");
  });
});

describe("Marketing Experiments", () => {
  test("only compares Creative from one Campaign and records a real decision", async () => {
    const companyId = testCompanyId();
    const firstCampaign = await createMarketingCampaign(
      companyId,
      { name: "First", objective: "traffic" },
      { userId: "member-1" },
    );
    const otherCampaign = await createMarketingCampaign(
      companyId,
      { name: "Other", objective: "traffic" },
      { userId: "member-1" },
    );
    const first = await createMarketingCreative(
      companyId,
      { campaignId: firstCampaign.id, name: "Pain-led" },
      { userId: "member-1" },
    );
    const second = await createMarketingCreative(
      companyId,
      { campaignId: firstCampaign.id, name: "Proof-led" },
      { userId: "member-1" },
    );
    const outsider = await createMarketingCreative(
      companyId,
      { campaignId: otherCampaign.id, name: "Wrong Campaign" },
      { userId: "member-1" },
    );

    await assert.rejects(
      createMarketingExperiment(
        companyId,
        {
          campaignId: firstCampaign.id,
          name: "Mixed test",
          creativeIds: [first.id, outsider.id],
        },
        { userId: "member-1" },
      ),
      /must belong to its Campaign/,
    );

    const experiment = await createMarketingExperiment(
      companyId,
      {
        campaignId: firstCampaign.id,
        name: "Message test",
        hypothesis: "Proof will improve qualified conversion rate.",
        primaryMetric: "qualified_conversion_rate",
        minimumSampleSize: "10000 impressions per variant",
        creativeIds: [first.id, second.id],
        status: "running",
      },
      { userId: "member-1" },
    );
    await assert.rejects(
      updateMarketingExperiment(companyId, experiment.id, {
        status: "decided",
        winnerCreativeId: first.id,
      }),
      /decision rationale/,
    );
    const decided = await updateMarketingExperiment(companyId, experiment.id, {
      status: "decided",
      winnerCreativeId: second.id,
      decisionRationale: "Proof-led won after both variants cleared the sample threshold.",
    });
    assert.equal(decided.winnerCreativeId, second.id);
  });
});

describe("Marketing performance and Grants", () => {
  test("keeps platform performance distinct and enforces access rank", async () => {
    const companyId = testCompanyId();
    const owner = await employee(companyId);
    const campaign = await createMarketingCampaign(
      companyId,
      {
        name: "Demand capture",
        objective: "sales",
        currency: "GBP",
      },
      { employeeId: owner.id },
    );
    await assert.rejects(
      recordMarketingPerformance(
        companyId,
        {
          campaignId: campaign.id,
          periodStart: daysAgo(8),
          periodEnd: daysAgo(1),
          spendMinor: 20_000,
          impressions: 40_000,
          clicks: 800,
          conversions: "12",
          conversionValue: "5400",
          currency: "USD",
          source: "google-ads weekly report",
        },
        { employeeId: owner.id },
      ),
      /Campaign currency/,
    );

    await recordMarketingPerformance(
      companyId,
      {
        campaignId: campaign.id,
        periodStart: daysAgo(8),
        periodEnd: daysAgo(1),
        spendMinor: 20_000,
        impressions: 40_000,
        clicks: 800,
        conversions: "12",
        conversionValue: "5400",
        currency: "GBP",
        source: "google-ads weekly report",
      },
      { employeeId: owner.id },
    );
    const overview = await getMarketingOverview(companyId);
    assert.equal(overview.performance.currency, "GBP");
    assert.equal(overview.performance.spendMinor, 20_000);
    assert.equal(overview.performance.impressions, 40_000);
    assert.equal(overview.performance.clicks, 800);
    assert.equal(overview.performance.conversions, 12);
    assert.equal(overview.performance.mixedCurrency, false);
    // 200.00 over 12 conversions.
    assert.equal(overview.performance.cpaMinor, 1_667);

    await upsertMarketingGrant(companyId, owner.id, "write");
    assert.equal(await hasMarketingAccess(owner.id, "read"), true);
    assert.equal(await hasMarketingAccess(owner.id, "operate"), false);
    await upsertMarketingGrant(companyId, owner.id, "operate");
    assert.equal(await hasMarketingAccess(owner.id, "operate"), true);
  });
});

describe("Marketing performance restatement", () => {
  test("restates a window instead of counting it twice, and refuses an overlap", async () => {
    const companyId = testCompanyId();
    const campaign = await createMarketingCampaign(
      companyId,
      { name: "Daily readouts", objective: "sales", currency: "USD" },
      { userId: "member-1" },
    );
    const window = { periodStart: daysAgo(2), periodEnd: daysAgo(1) };
    const first = await recordMarketingPerformance(
      companyId,
      { campaignId: campaign.id, ...window, spendMinor: 10_000, currency: "USD", source: "meta-ads" },
      { userId: "member-1" },
    );

    // A Routine that retried after a crash sends the same day again.
    const restated = await recordMarketingPerformance(
      companyId,
      {
        campaignId: campaign.id,
        ...window,
        spendMinor: 12_500,
        conversions: "5",
        currency: "USD",
        source: "meta-ads settled",
      },
      { userId: "member-1" },
    );
    assert.notEqual(restated.id, first.id);

    const detail = await getMarketingCampaign(companyId, campaign.id);
    assert.equal(detail.snapshotCount, 2, "the superseded row is kept as history");
    assert.equal(detail.metrics.totals.spendMinor, 12_500, "but only the live row is counted");
    assert.equal(detail.metrics.totals.snapshots, 1);
    assert.ok(detail.snapshots.some((row) => row.supersededAt));

    // A weekly readout containing that day would count the same money twice.
    await assert.rejects(
      recordMarketingPerformance(
        companyId,
        {
          campaignId: campaign.id,
          periodStart: daysAgo(7),
          periodEnd: daysAgo(0),
          spendMinor: 70_000,
          currency: "USD",
          source: "meta-ads weekly",
        },
        { userId: "member-1" },
      ),
      /overlaps an existing readout/,
    );
  });
});

describe("Marketing lifecycle", () => {
  test("a Campaign cannot skip the state that exists to force a review", async () => {
    const companyId = testCompanyId();
    const campaign = await createMarketingCampaign(
      companyId,
      {
        name: "Skip the queue",
        objective: "leads",
        channel: "google-ads",
        brief: "Brief.",
        audience: "Audience.",
        successMetric: "cpa",
        dailyBudgetMinor: 5_000,
        externalCampaignId: "ext-1",
      },
      { userId: "member-1" },
    );
    assert.equal(campaign.status, "draft");
    await assert.rejects(
      updateMarketingCampaign(companyId, campaign.id, { status: "active" }),
      /cannot go from draft to active/,
    );
    await assert.rejects(
      createMarketingCampaign(
        companyId,
        { name: "Born live", objective: "leads", status: "active" },
        { userId: "member-1" },
      ),
      /starts as draft or ready/,
    );
    await updateMarketingCampaign(companyId, campaign.id, { status: "ready" });
    const live = await updateMarketingCampaign(companyId, campaign.id, { status: "active" });
    assert.equal(live.status, "active");
  });

  test("Creative only goes live under a live Campaign, and only after approval", async () => {
    const companyId = testCompanyId();
    const campaign = await createMarketingCampaign(
      companyId,
      { name: "Paused work", objective: "traffic" },
      { userId: "member-1" },
    );
    const creative = await createMarketingCreative(
      companyId,
      { campaignId: campaign.id, name: "Proof-led", status: "review" },
      { userId: "member-1" },
    );
    await assert.rejects(
      updateMarketingCreative(companyId, creative.id, { status: "active" }),
      /cannot go from review to active/,
    );
    await updateMarketingCreative(companyId, creative.id, { status: "approved" });
    await assert.rejects(
      updateMarketingCreative(companyId, creative.id, { status: "active" }),
      /only go live under an active Campaign/,
    );
  });
});

describe("Marketing Experiment decisions", () => {
  test("promoting the winner retires what it beat", async () => {
    const companyId = testCompanyId();
    const campaign = await createMarketingCampaign(
      companyId,
      {
        name: "Message test",
        objective: "leads",
        channel: "meta-ads",
        brief: "Brief.",
        audience: "Audience.",
        successMetric: "cpa",
        dailyBudgetMinor: 5_000,
        externalCampaignId: "ext-2",
        status: "ready",
      },
      { userId: "member-1" },
    );
    await updateMarketingCampaign(companyId, campaign.id, { status: "active" });
    const loser = await createMarketingCreative(
      companyId,
      { campaignId: campaign.id, name: "Pain-led", status: "review" },
      { userId: "member-1" },
    );
    const winner = await createMarketingCreative(
      companyId,
      { campaignId: campaign.id, name: "Proof-led", status: "review" },
      { userId: "member-1" },
    );
    await updateMarketingCreative(companyId, loser.id, { status: "approved" });
    await updateMarketingCreative(companyId, loser.id, { status: "active" });

    const experiment = await createMarketingExperiment(
      companyId,
      {
        campaignId: campaign.id,
        name: "Proof beats pain",
        hypothesis: "Proof-led copy converts better.",
        minimumSampleSize: "10000 impressions per variant",
        creativeIds: [loser.id, winner.id],
        status: "running",
      },
      { userId: "member-1" },
    );
    assert.ok(experiment.startsAt, "starting stamps its own clock");

    await updateMarketingExperiment(companyId, experiment.id, {
      status: "decided",
      winnerCreativeId: winner.id,
      decisionRationale: "Proof-led won on qualified conversion rate.",
      promoteWinner: true,
    });

    const detail = await getMarketingCampaign(companyId, campaign.id);
    const byId = new Map(detail.creatives.map((row) => [row.id, row]));
    assert.equal(byId.get(winner.id)?.status, "active");
    assert.equal(byId.get(loser.id)?.status, "retired");
    assert.ok(detail.experiments[0]?.endsAt, "deciding stamps the end");

    await assert.rejects(
      updateMarketingExperiment(companyId, experiment.id, { status: "running" }),
      /is final/,
    );
  });
});

describe("Marketing scoring", () => {
  test("scores each Campaign against its own target and surfaces the misses", async () => {
    const companyId = testCompanyId();
    const campaign = await createMarketingCampaign(
      companyId,
      {
        name: "Expensive leads",
        objective: "leads",
        channel: "google-ads",
        brief: "Brief.",
        audience: "Audience.",
        successMetric: "cost_per_lead",
        targetValue: "40",
        dailyBudgetMinor: 10_000,
        externalCampaignId: "ext-3",
        status: "ready",
      },
      { userId: "member-1" },
    );
    // A cost goal defaults to "at most" without anyone saying so.
    assert.equal(campaign.targetDirection, "at_most");
    await updateMarketingCampaign(companyId, campaign.id, { status: "active" });
    await recordMarketingPerformance(
      companyId,
      {
        campaignId: campaign.id,
        periodStart: daysAgo(2),
        periodEnd: daysAgo(1),
        spendMinor: 10_000,
        impressions: 50_000,
        clicks: 1_000,
        conversions: "2",
        currency: "USD",
        source: "google-ads",
      },
      { userId: "member-1" },
    );

    const [scored] = await listMarketingCampaignsWithMetrics(companyId);
    assert.equal(scored.metrics.target.metricKey, "cpa");
    assert.equal(scored.metrics.target.actualValue, 50);
    assert.equal(scored.metrics.target.state, "off_target");
    assert.equal(scored.metrics.derived.ctr, 0.02);

    const overview = await getMarketingOverview(companyId);
    assert.ok(overview.attention.some((item) => item.code === "off_target"));
    assert.equal(overview.attention[0]?.campaignName, "Expensive leads");
    assert.ok(overview.counts.needsAttention >= 1);
  });
});
