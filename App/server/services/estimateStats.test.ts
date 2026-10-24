import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Estimate } from "../db/entities/Estimate.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { addDays, dayStart } from "../../shared/documentDays.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  acceptEstimate,
  convertEstimateToInvoice,
  createEstimateDraft,
  declineEstimate,
  displayEstimateStatus,
  issueEstimate,
  setEstimatesArchived,
  voidEstimate,
} from "./estimates.js";
import { getFinanceSettings, setRate } from "./fx.js";
import { estimateOutcome, estimateStats } from "./estimateStats.js";

/**
 * Finance → Estimates leads with what is open with customers, what is about
 * to lapse, what was won but not yet billed, and how the last 90 days of
 * quotes went — in the home currency, with days read on the company's clock.
 * Every estimate is drafted, issued, accepted, declined, converted, voided
 * and archived through the services the product uses.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/** Noon UTC: the same calendar day from UTC-11 to UTC+11. */
const NOW = new Date("2026-10-24T12:00:00.000Z");
const TODAY = "2026-10-24";

let company: Company;
let acme: Customer;
let globex: Customer;
let initech: Customer;

function day(offset: number): Date {
  return dayStart(addDays(TODAY, offset));
}

async function newCompany(timezone = "UTC"): Promise<Company> {
  return insert(Company, {
    name: "Sunwise",
    slug: `sunwise-${randomUUID().slice(0, 8)}`,
    ownerId: randomUUID(),
    timezone,
  });
}

async function customer(owner: Company, name: string): Promise<Customer> {
  return insert(Customer, {
    companyId: owner.id,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    email: `quotes@${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`,
    currency: "USD",
  });
}

beforeEach(async () => {
  company = await newCompany();
  await getFinanceSettings(company.id);
  acme = await customer(company, "Acme Corp");
  globex = await customer(company, "Globex");
  initech = await customer(company, "Initech");
});

type QuoteOptions = {
  to?: Customer;
  amountCents: number;
  currency?: string;
  issued?: Date;
  validUntil?: Date;
  taxRateId?: string | null;
  owner?: Company;
};

/** An estimate issued the way Issue does it: numbered and sent. */
async function quoted(options: QuoteOptions): Promise<Estimate> {
  const owner = options.owner ?? company;
  const draft = await createEstimateDraft({
    companyId: owner.id,
    customerId: (options.to ?? acme).id,
    issueDate: options.issued ?? day(-5),
    validUntil: options.validUntil ?? day(25),
    currency: options.currency ?? "USD",
    lines: [
      {
        description: "Solar install",
        quantity: 1,
        unitPriceCents: options.amountCents,
        taxRateId: options.taxRateId ?? null,
      },
    ],
  });
  return issueEstimate(draft, null);
}

async function fresh(estimate: Estimate): Promise<Estimate> {
  return AppDataSource.getRepository(Estimate).findOneByOrFail({ id: estimate.id });
}

async function accepted(options: QuoteOptions, acceptedAt?: Date): Promise<Estimate> {
  const estimate = await acceptEstimate(await quoted(options), null);
  if (acceptedAt) await AppDataSource.getRepository(Estimate).update(estimate.id, { acceptedAt });
  return fresh(estimate);
}

describe("estimateOutcome", () => {
  test("reads where an issued estimate stands on a calendar day", () => {
    const base = { validUntil: dayStart("2026-10-24"), invoiceId: null };
    assert.equal(estimateOutcome({ ...base, status: "sent" }, "2026-10-24"), "open");
    assert.equal(estimateOutcome({ ...base, status: "sent" }, "2026-10-25"), "expired");
    assert.equal(estimateOutcome({ ...base, status: "accepted" }, "2026-12-01"), "accepted");
    assert.equal(estimateOutcome({ ...base, status: "declined" }, "2026-10-01"), "declined");
    assert.equal(
      estimateOutcome({ ...base, status: "sent", invoiceId: "inv-1" }, "2026-12-01"),
      "invoiced",
    );
  });
});

describe("estimateStats", () => {
  test("an empty company has nothing to sum up", async () => {
    const stats = await estimateStats(company.id, NOW);
    assert.equal(stats.currency, "USD");
    assert.equal(stats.timeZone, "UTC");
    assert.equal(stats.today, TODAY);
    assert.equal(stats.issuedEstimates, 0);
    assert.deepEqual(stats.open, { count: 0, amountCents: 0, ids: [], customers: 0 });
    assert.deepEqual(stats.expiringSoon, {
      count: 0,
      amountCents: 0,
      ids: [],
      days: 14,
      firstValidUntil: null,
    });
    assert.deepEqual(stats.acceptedNotInvoiced, {
      count: 0,
      amountCents: 0,
      ids: [],
      oldestDaysWaiting: null,
    });
    assert.equal(stats.recent.days, 90);
    assert.deepEqual(
      stats.recent.outcomes.map((row) => [row.outcome, row.count]),
      [
        ["invoiced", 0],
        ["accepted", 0],
        ["open", 0],
        ["expired", 0],
        ["declined", 0],
      ],
    );
    assert.deepEqual(stats.recent.acceptance, { accepted: 0, decided: 0, ids: [] });
    assert.deepEqual(stats.recent.lost, {
      count: 0,
      amountCents: 0,
      ids: [],
      declined: 0,
      expired: 0,
    });
    assert.equal(stats.largestCustomer, null);
  });

  test("open is what sent estimates within their valid-until date come to, tax included", async () => {
    const vat = await insert(TaxRate, { companyId: company.id, name: "VAT", ratePercent: 20 });
    const withVat = await quoted({ amountCents: 100_000, taxRateId: vat.id });
    const plain = await quoted({ to: globex, amountCents: 40_000 });
    await accepted({ to: initech, amountCents: 70_000 });
    const declined = await declineEstimate(await quoted({ amountCents: 5_000 }), null);
    await quoted({ amountCents: 6_000, issued: day(-40), validUntil: day(-1) });

    const stats = await estimateStats(company.id, NOW);
    assert.equal(stats.open.amountCents, 120_000 + 40_000);
    assert.deepEqual(new Set(stats.open.ids), new Set([withVat.id, plain.id]));
    assert.equal(stats.open.customers, 2);
    assert.equal(stats.issuedEstimates, 5);
    assert.ok(!stats.open.ids.includes(declined.id));
  });

  test("drafts and voided estimates count nowhere", async () => {
    await createEstimateDraft({
      companyId: company.id,
      customerId: acme.id,
      issueDate: day(-3),
      validUntil: day(3),
      lines: [{ description: "Draft", quantity: 1, unitPriceCents: 90_000 }],
    });
    await voidEstimate(await quoted({ amountCents: 80_000 }), null);
    const kept = await quoted({ to: globex, amountCents: 1_000 });

    const stats = await estimateStats(company.id, NOW);
    assert.equal(stats.issuedEstimates, 1);
    assert.deepEqual(stats.open.ids, [kept.id]);
    assert.equal(
      stats.recent.outcomes.reduce((sum, row) => sum + row.count, 0),
      1,
      "the void and the draft are in no outcome",
    );
  });

  test("an estimate is open through its valid-until date and expired the day after", async () => {
    const lastDay = await quoted({ amountCents: 1_000, validUntil: day(0) });
    const day14 = await quoted({ amountCents: 2_000, validUntil: day(14) });
    const day15 = await quoted({ amountCents: 4_000, validUntil: day(15) });
    const lapsed = await quoted({ amountCents: 8_000, issued: day(-20), validUntil: day(-1) });

    const stats = await estimateStats(company.id, NOW);
    assert.deepEqual(stats.open.ids, [lastDay.id, day14.id, day15.id]);
    assert.deepEqual(stats.expiringSoon.ids, [lastDay.id, day14.id]);
    assert.equal(stats.expiringSoon.amountCents, 3_000);
    assert.equal(stats.expiringSoon.firstValidUntil, TODAY);
    const expired = stats.recent.outcomes.find((row) => row.outcome === "expired")!;
    assert.deepEqual(expired.ids, [lapsed.id]);
    assert.deepEqual(stats.recent.lost.ids, [lapsed.id]);
    assert.equal(stats.recent.lost.expired, 1);
  });

  test("an accepted estimate waits to be invoiced however long ago its validity ran out", async () => {
    const waiting = await accepted(
      { amountCents: 30_000, issued: day(-50), validUntil: day(-20) },
      new Date("2026-09-10T15:00:00.000Z"),
    );
    const recent = await accepted({ to: globex, amountCents: 10_000 }, NOW);
    const converted = await accepted({ to: initech, amountCents: 50_000 });
    await convertEstimateToInvoice(await fresh(converted), null);

    const stats = await estimateStats(company.id, NOW);
    assert.deepEqual(new Set(stats.acceptedNotInvoiced.ids), new Set([waiting.id, recent.id]));
    assert.equal(stats.acceptedNotInvoiced.amountCents, 40_000);
    assert.equal(stats.acceptedNotInvoiced.oldestDaysWaiting, 44);
    assert.equal(stats.recent.lost.count, 0, "lapsing after the customer said yes loses nothing");
    assert.equal(displayEstimateStatus(waiting, NOW), "accepted");
  });

  test("the recent figures follow the estimates issued in the last 90 days, by where each stands now", async () => {
    // Won: accepted, converted after acceptance, and converted straight from sent.
    const yes = await accepted({ amountCents: 10_000, issued: day(-10) });
    const billed = await accepted({ to: globex, amountCents: 20_000, issued: day(-30) });
    await convertEstimateToInvoice(await fresh(billed), null);
    const direct = await quoted({ to: initech, amountCents: 40_000, issued: day(-89) });
    await convertEstimateToInvoice(await fresh(direct), null);
    // Lost: declined, and lapsed without an answer.
    const no = await declineEstimate(await quoted({ amountCents: 80_000, issued: day(-60) }), null);
    const silent = await quoted({ amountCents: 160_000, issued: day(-45), validUntil: day(-15) });
    // Undecided, and issued too long ago to count.
    const pending = await quoted({ to: globex, amountCents: 320_000, issued: day(-2) });
    const tooOld = await declineEstimate(
      await quoted({ amountCents: 640_000, issued: day(-90) }),
      null,
    );

    const stats = await estimateStats(company.id, NOW);
    const outcome = (name: string) => stats.recent.outcomes.find((row) => row.outcome === name)!;
    assert.deepEqual(new Set(outcome("invoiced").ids), new Set([billed.id, direct.id]));
    assert.equal(outcome("invoiced").amountCents, 60_000);
    assert.deepEqual(outcome("accepted").ids, [yes.id]);
    assert.deepEqual(outcome("open").ids, [pending.id]);
    assert.deepEqual(outcome("expired").ids, [silent.id]);
    assert.deepEqual(outcome("declined").ids, [no.id]);
    assert.equal(stats.recent.acceptance.accepted, 3);
    assert.equal(stats.recent.acceptance.decided, 5);
    assert.deepEqual(
      new Set(stats.recent.acceptance.ids),
      new Set([yes.id, billed.id, direct.id, no.id, silent.id]),
      "the undecided don't count against the rate",
    );
    assert.equal(stats.recent.lost.amountCents, 240_000);
    assert.equal(stats.recent.lost.declined, 1);
    assert.equal(stats.recent.lost.expired, 1);
    assert.ok(
      !stats.recent.outcomes.some((row) => row.ids.includes(tooOld.id)),
      "issued 90 days ago is outside the last 90 days",
    );
  });

  test("archiving takes an estimate out of what is open, but what its customer decided still counts", async () => {
    const filedOpen = await quoted({ amountCents: 10_000 });
    const filedAccepted = await accepted({ to: globex, amountCents: 20_000 });
    const filedDeclined = await declineEstimate(await quoted({ amountCents: 40_000 }), null);
    const live = await quoted({ to: initech, amountCents: 80_000 });
    await setEstimatesArchived(
      company.id,
      [filedOpen.id, filedAccepted.id, filedDeclined.id],
      "archive",
    );

    const stats = await estimateStats(company.id, NOW);
    assert.deepEqual(stats.open.ids, [live.id]);
    assert.deepEqual(stats.acceptedNotInvoiced.ids, []);
    const outcome = (name: string) => stats.recent.outcomes.find((row) => row.outcome === name)!;
    assert.deepEqual(outcome("open").ids, [live.id], "a filed-away open estimate counts nowhere");
    assert.deepEqual(outcome("accepted").ids, [filedAccepted.id]);
    assert.deepEqual(outcome("declined").ids, [filedDeclined.id]);
    assert.equal(stats.recent.acceptance.decided, 2);
    assert.equal(stats.issuedEstimates, 4);
  });

  test("an estimate issued long ago is still open while it is valid", async () => {
    const longRunning = await quoted({ amountCents: 9_000, issued: day(-200), validUntil: day(60) });
    const stats = await estimateStats(company.id, NOW);
    assert.deepEqual(stats.open.ids, [longRunning.id]);
    assert.equal(
      stats.recent.outcomes.reduce((sum, row) => sum + row.count, 0),
      0,
      "but it is not among the last 90 days' quotes",
    );
  });

  test("another currency converts at the rate on file for the issue date, or the latest when none is that old", async () => {
    await setRate(company.id, "EUR", "USD", dayStart("2026-09-01"), 1.1, "manual");
    await setRate(company.id, "EUR", "USD", dayStart("2026-10-20"), 1.3, "manual");
    // Issued on the 10th: the rate of the 1st, not the newer one.
    const euro = await quoted({ amountCents: 100_000, currency: "EUR", issued: day(-14) });
    // Issued before sterling had any rate: the latest one there is.
    await setRate(company.id, "GBP", "USD", dayStart("2026-10-22"), 1.25, "manual");
    const sterling = await quoted({
      to: globex,
      amountCents: 40_000,
      currency: "GBP",
      issued: day(-30),
    });
    // No rate for yen at all: named, and counted nowhere.
    const yen = await quoted({ to: initech, amountCents: 999_900, currency: "JPY" });

    const stats = await estimateStats(company.id, NOW);
    assert.equal(stats.open.amountCents, 110_000 + 50_000);
    assert.deepEqual(new Set(stats.open.ids), new Set([euro.id, sterling.id]));
    assert.ok(!stats.open.ids.includes(yen.id));
    assert.deepEqual(stats.converted, ["EUR", "GBP"]);
    assert.deepEqual(stats.unconverted, [{ currency: "JPY", estimates: 1 }]);
    assert.equal(stats.largestCustomer?.id, acme.id);
  });

  test("the company's time zone decides what today is", async () => {
    // 20:00 UTC: already the 25th in Singapore, still the 24th in California.
    const evening = new Date("2026-10-24T20:00:00.000Z");
    const lastDay = await quoted({ amountCents: 7_000, issued: day(-30), validUntil: day(0) });
    // Accepted at 18:00 UTC on 10 October: the 11th in Singapore.
    await accepted({ to: globex, amountCents: 3_000 }, new Date("2026-10-10T18:00:00.000Z"));

    await AppDataSource.getRepository(Company).update(company.id, { timezone: "Asia/Singapore" });
    const singapore = await estimateStats(company.id, evening);
    assert.equal(singapore.today, "2026-10-25");
    assert.deepEqual(singapore.open.ids, []);
    assert.deepEqual(singapore.recent.lost.ids, [lastDay.id]);
    assert.equal(singapore.acceptedNotInvoiced.oldestDaysWaiting, 14);

    await AppDataSource.getRepository(Company).update(company.id, {
      timezone: "America/Los_Angeles",
    });
    const california = await estimateStats(company.id, evening);
    assert.equal(california.today, "2026-10-24");
    assert.deepEqual(california.open.ids, [lastDay.id]);
    assert.deepEqual(california.expiringSoon.ids, [lastDay.id]);
    assert.equal(california.expiringSoon.firstValidUntil, "2026-10-24");
    assert.deepEqual(california.recent.lost.ids, []);
    assert.equal(california.acceptedNotInvoiced.oldestDaysWaiting, 14);
  });

  test("the largest customer holds the most of what is open, a tie going to the name first", async () => {
    await quoted({ to: globex, amountCents: 50_000 });
    await quoted({ to: acme, amountCents: 50_000 });
    const tie = await estimateStats(company.id, NOW);
    assert.equal(tie.largestCustomer?.name, "Acme Corp");

    const big = await quoted({ to: initech, amountCents: 90_000 });
    const stats = await estimateStats(company.id, NOW);
    assert.equal(stats.largestCustomer?.id, initech.id);
    assert.deepEqual(stats.largestCustomer?.ids, [big.id]);
    assert.equal(stats.largestCustomer?.amountCents, 90_000);
    assert.equal(stats.open.amountCents, 190_000);
  });

  test("another company's estimates never count", async () => {
    const other = await newCompany();
    await getFinanceSettings(other.id);
    const stranger = await customer(other, "Stranger Things");
    const theirs = await quoted({ owner: other, to: stranger, amountCents: 12_000 });
    const ours = await quoted({ amountCents: 3_000 });

    const stats = await estimateStats(company.id, NOW);
    assert.equal(stats.issuedEstimates, 1);
    assert.deepEqual(stats.open.ids, [ours.id]);
    const theirStats = await estimateStats(other.id, NOW);
    assert.deepEqual(theirStats.open.ids, [theirs.id]);
  });
});

describe("displayEstimateStatus", () => {
  test("an accepted estimate stays accepted past its valid-until date; a sent one expires", () => {
    const base = { validUntil: new Date("2026-10-01T00:00:00.000Z"), invoiceId: null };
    assert.equal(displayEstimateStatus({ ...base, status: "accepted" }, NOW), "accepted");
    assert.equal(displayEstimateStatus({ ...base, status: "sent" }, NOW), "expired");
    assert.equal(
      displayEstimateStatus({ ...base, status: "accepted", invoiceId: "inv" }, NOW),
      "invoiced",
    );
  });
});
