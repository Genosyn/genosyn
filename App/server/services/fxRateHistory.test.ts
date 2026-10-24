import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { getFinanceSettings, rateHistory, rateOnFile, setAutomaticExchangeRates } from "./fx.js";

/**
 * `rateHistory` reads a currency pair's rates once and answers for any date
 * as `rateOnFile` would, so a page converting hundreds of documents dated
 * across a year asks the database once rather than once a day.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

let companyId: string;

beforeEach(async () => {
  companyId = `co_${randomUUID()}`;
  await getFinanceSettings(companyId);
});

async function rate(
  from: string,
  to: string,
  day: string,
  value: number,
  automatic = false,
): Promise<void> {
  await insert(ExchangeRate, {
    companyId,
    fromCurrency: from,
    toCurrency: to,
    date: new Date(`${day}T00:00:00.000Z`),
    rate: value,
    source: automatic ? "ecb" : "manual",
    automatic,
  });
}

/** Every day from `first` to `last`, as midnight UTC and an afternoon instant. */
function datesBetween(first: string, last: string): Date[] {
  const dates: Date[] = [];
  for (
    let at = new Date(`${first}T00:00:00.000Z`).getTime();
    at <= new Date(`${last}T00:00:00.000Z`).getTime();
    at += 86_400_000
  ) {
    dates.push(new Date(at), new Date(at + 15 * 3_600_000));
  }
  return dates;
}

async function assertSameAsRateOnFile(from: string, to: string, until: Date): Promise<number> {
  const rateOn = await rateHistory(companyId, from, to, until);
  let compared = 0;
  for (const date of datesBetween("2026-08-25", "2026-10-26")) {
    if (date.getTime() > until.getTime()) continue;
    const expected = (await rateOnFile(companyId, from, to, date))?.rate ?? null;
    assert.equal(rateOn(date), expected, `${from}→${to} on ${date.toISOString()}`);
    compared += 1;
  }
  return compared;
}

describe("rateHistory", () => {
  test("answers every date as rateOnFile does: the latest direct rate, else the inverse", async () => {
    await rate("EUR", "USD", "2026-09-01", 1.1);
    await rate("EUR", "USD", "2026-09-15", 1.12, true);
    await rate("EUR", "USD", "2026-10-01", 0); // a fat-fingered zero, skipped
    await rate("EUR", "USD", "2026-10-02", 1.15);
    // Only the opposite pair before September: read as its inverse.
    await rate("USD", "EUR", "2026-08-28", 0.8);
    await rate("USD", "EUR", "2026-09-20", 0.5); // a direct rate wins once there is one
    const until = new Date("2026-10-26T00:00:00.000Z");

    const compared = await assertSameAsRateOnFile("EUR", "USD", until);
    assert.ok(compared > 100, `compared only ${compared} dates`);
    await assertSameAsRateOnFile("USD", "EUR", until);

    const rateOn = await rateHistory(companyId, "EUR", "USD", until);
    assert.equal(rateOn(new Date("2026-08-26T00:00:00.000Z")), null, "nothing that old");
    assert.equal(rateOn(new Date("2026-08-29T00:00:00.000Z")), 1.25, "the inverse of 0.8");
    assert.equal(rateOn(new Date("2026-09-30T12:00:00.000Z")), 1.12);
    assert.equal(rateOn(new Date("2026-10-01T12:00:00.000Z")), 1.12, "the zero is skipped");
    assert.equal(rateOn(new Date("2026-10-02T00:00:00.000Z")), 1.15, "a rate counts from its own day");
  });

  test("skips fetched rates while automatic rates are off, as rateOnFile does", async () => {
    await rate("GBP", "USD", "2026-09-01", 1.3);
    await rate("GBP", "USD", "2026-09-10", 1.31, true);
    await rate("GBP", "USD", "2026-10-10", 1.33, true);
    await setAutomaticExchangeRates(companyId, false);
    const until = new Date("2026-10-26T00:00:00.000Z");
    await assertSameAsRateOnFile("GBP", "USD", until);
    const rateOn = await rateHistory(companyId, "GBP", "USD", until);
    assert.equal(rateOn(new Date("2026-10-20T00:00:00.000Z")), 1.3);
  });

  test("never reads a rate dated after its horizon, nor another company's", async () => {
    await rate("JPY", "USD", "2026-10-20", 0.0067);
    await insert(ExchangeRate, {
      companyId: `co_${randomUUID()}`,
      fromCurrency: "JPY",
      toCurrency: "USD",
      date: new Date("2026-09-01T00:00:00.000Z"),
      rate: 0.007,
      source: "manual",
      automatic: false,
    });
    const rateOn = await rateHistory(companyId, "JPY", "USD", new Date("2026-10-19T00:00:00.000Z"));
    assert.equal(rateOn(new Date("2026-10-25T00:00:00.000Z")), null);
    assert.equal(rateOn(new Date("2026-09-02T00:00:00.000Z")), null);
  });
});
