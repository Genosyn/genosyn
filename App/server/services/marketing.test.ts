import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import {
  MarketingValidationError,
  createMarketingCampaign,
  createMarketingCreative,
  createMarketingExperiment,
  getMarketingOverview,
  hasMarketingAccess,
  recordMarketingPerformance,
  updateMarketingCampaign,
  updateMarketingExperiment,
  upsertMarketingGrant,
} from "./marketing.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

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
          periodStart: "2026-07-20T00:00:00.000Z",
          periodEnd: "2026-07-27T00:00:00.000Z",
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
        periodStart: "2026-07-20T00:00:00.000Z",
        periodEnd: "2026-07-27T00:00:00.000Z",
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
    assert.deepEqual(overview.latestPerformance, {
      currency: "GBP",
      spendMinor: 20_000,
      impressions: 40_000,
      clicks: 800,
      conversions: 12,
    });

    await upsertMarketingGrant(companyId, owner.id, "write");
    assert.equal(await hasMarketingAccess(owner.id, "read"), true);
    assert.equal(await hasMarketingAccess(owner.id, "operate"), false);
    await upsertMarketingGrant(companyId, owner.id, "operate");
    assert.equal(await hasMarketingAccess(owner.id, "operate"), true);
  });
});
