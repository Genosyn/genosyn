import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { CompanyFinanceSettings } from "../db/entities/CompanyFinanceSettings.js";
import { Currency } from "../db/entities/Currency.js";
import { Customer } from "../db/entities/Customer.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  exchangeRateOverview,
  fillCompanyRates,
  parseEcbRates,
  rateBetween,
  refreshExchangeRates,
} from "./exchangeRateFeed.js";
import { lookupRate, setRate } from "./fx.js";

/**
 * Automatic exchange rates come from the ECB's reference rates: read
 * strictly, crossed through the euro, filed one row per currency and day, and
 * never written over a rate a person set.
 */

// The daily file, as the ECB serves it: single-quoted attributes.
const DAILY = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<gesmes:Sender>
		<gesmes:name>European Central Bank</gesmes:name>
	</gesmes:Sender>
	<Cube>
		<Cube time='2026-10-22'>
			<Cube currency='USD' rate='1.1205'/>
			<Cube currency='JPY' rate='175.97'/>
			<Cube currency='GBP' rate='0.83770'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;

// The history files: double-quoted, a day per line, oldest last.
const HISTORY =
  `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>Reference rates</gesmes:subject><Cube>` +
  `<Cube time="2026-10-22"><Cube currency="USD" rate="1.1205"/><Cube currency="GBP" rate="0.8377"/></Cube>\n` +
  `<Cube time="2026-10-21"><Cube currency="USD" rate="1.1234"/><Cube currency="GBP" rate="0.83825"/></Cube>\n` +
  `</Cube></gesmes:Envelope>`;

describe("reading the ECB feed", () => {
  test("reads the daily and the history files, newest day first", () => {
    const [daily] = parseEcbRates(DAILY);
    assert.equal(daily.date, "2026-10-22");
    assert.deepEqual(
      [...daily.perEuro],
      [
        ["EUR", 1],
        ["USD", 1.1205],
        ["JPY", 175.97],
        ["GBP", 0.8377],
      ],
    );
    assert.deepEqual(
      parseEcbRates(HISTORY).map((day) => day.date),
      ["2026-10-22", "2026-10-21"],
    );
  });

  test("ignores whatever isn't a rate", () => {
    const days = parseEcbRates(
      `<Cube time="2026-02-30"><Cube currency="USD" rate="1.1"/></Cube>` +
        `<Cube time="2026-10-20"><Cube currency="usd" rate="1.1"/><Cube currency="GBP" rate="0"/>` +
        `<Cube currency="JPY" rate="lots"/><Cube currency="CHF" rate="0.92"/></Cube>` +
        `<Cube time="2026-10-19"></Cube>`,
    );
    assert.deepEqual(
      days.map((day) => [day.date, [...day.perEuro]]),
      [
        [
          "2026-10-20",
          [
            ["EUR", 1],
            ["CHF", 0.92],
          ],
        ],
      ],
    );
    assert.deepEqual(parseEcbRates("<html>Service unavailable</html>"), []);
  });

  test("crosses two currencies through the euro, to six significant figures", () => {
    const [day] = parseEcbRates(DAILY);
    assert.equal(rateBetween(day, "EUR", "USD"), 1.1205);
    assert.equal(rateBetween(day, "USD", "EUR"), 0.892459);
    assert.equal(rateBetween(day, "GBP", "USD"), 1.33759);
    assert.equal(rateBetween(day, "jpy", "usd"), 0.00636756);
    assert.equal(rateBetween(day, "USD", "AED"), null);
  });
});

describe("filling a company's rates", () => {
  let actingUserId: string;
  let companyId: string;

  before(initTestDb);
  after(closeTestDb);

  beforeEach(async () => {
    await resetTestDb();
    const owner = await insert(User, {
      email: `owner-${randomUUID()}@example.com`,
      name: "Owner",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = owner.id;
    const company = await insert(Company, {
      name: "Sunwise",
      slug: randomUUID(),
      ownerId: actingUserId,
    });
    companyId = company.id;
    await insert(CompanyFinanceSettings, { companyId, homeCurrency: "USD", invoiceCcEmails: [] });
    for (const code of ["EUR", "GBP", "JPY", "USD"]) {
      await insert(Currency, { companyId, code, name: code, symbol: "", decimalPlaces: 2 });
    }
  });

  function rates(): Promise<ExchangeRate[]> {
    return AppDataSource.getRepository(ExchangeRate).find({
      where: { companyId },
      order: { fromCurrency: "ASC", toCurrency: "ASC", date: "ASC" },
    });
  }

  function summary(rows: ExchangeRate[]): string[] {
    return rows.map(
      (row) =>
        `${row.fromCurrency}→${row.toCurrency} ${row.date.toISOString().slice(0, 10)} ${row.rate} ${row.automatic ? "ECB" : "set"}`,
    );
  }

  test("files each quoted currency into the home currency, once per day", async () => {
    const days = parseEcbRates(HISTORY);
    // JPY is in the catalog but not in this feed, and USD is home.
    assert.equal(await fillCompanyRates(companyId, days), 4);
    assert.deepEqual(summary(await rates()), [
      "EUR→USD 2026-10-21 1.1234 ECB",
      "EUR→USD 2026-10-22 1.1205 ECB",
      "GBP→USD 2026-10-21 1.34017 ECB",
      "GBP→USD 2026-10-22 1.33759 ECB",
    ]);
    assert.equal((await rates())[0].source, "ECB");
    assert.equal(await fillCompanyRates(companyId, days), 0, "a second pass adds nothing");
  });

  test("never writes over a rate a person set, in either direction", async () => {
    await setRate(companyId, "EUR", "USD", new Date("2026-10-22T00:00:00.000Z"), 1.1, "bank");
    await setRate(companyId, "USD", "GBP", new Date("2026-10-21T00:00:00.000Z"), 0.75, "bank");
    assert.equal(await fillCompanyRates(companyId, parseEcbRates(HISTORY)), 2);
    assert.deepEqual(summary(await rates()), [
      "EUR→USD 2026-10-21 1.1234 ECB",
      "EUR→USD 2026-10-22 1.1 set",
      "GBP→USD 2026-10-22 1.33759 ECB",
      "USD→GBP 2026-10-21 0.75 set",
    ]);
  });

  test("a person's rate replaces a fetched one for its day", async () => {
    await fillCompanyRates(companyId, parseEcbRates(HISTORY));
    await setRate(companyId, "EUR", "USD", new Date("2026-10-22T00:00:00.000Z"), 1.1, "bank");
    const replaced = await AppDataSource.getRepository(ExchangeRate).findOneByOrFail({
      companyId,
      fromCurrency: "EUR",
      date: new Date("2026-10-22T00:00:00.000Z"),
    });
    assert.equal(replaced.rate, 1.1);
    assert.equal(replaced.automatic, false);
    assert.equal(replaced.source, "bank");
  });

  test("adds nothing while automatic rates are off, or for a home currency the ECB doesn't quote", async () => {
    const settings = AppDataSource.getRepository(CompanyFinanceSettings);
    await settings.update({ companyId }, { automaticExchangeRates: false });
    assert.equal(await fillCompanyRates(companyId, parseEcbRates(HISTORY)), 0);
    await settings.update({ companyId }, { automaticExchangeRates: true, homeCurrency: "AED" });
    assert.equal(await fillCompanyRates(companyId, parseEcbRates(HISTORY)), 0);
    assert.deepEqual(await rates(), []);
  });

  test("conversions skip fetched rates while automatic rates are off", async () => {
    await fillCompanyRates(companyId, parseEcbRates(HISTORY));
    await setRate(companyId, "EUR", "USD", new Date("2026-10-01T00:00:00.000Z"), 1.05, "bank");
    const on = new Date("2026-10-23T12:00:00.000Z");
    assert.equal((await lookupRate(companyId, "EUR", "USD", on)).rate, 1.1205);
    assert.equal((await lookupRate(companyId, "USD", "GBP", on)).rate, 1 / 1.33759);

    await AppDataSource.getRepository(CompanyFinanceSettings).update(
      { companyId },
      { automaticExchangeRates: false },
    );
    assert.equal((await lookupRate(companyId, "EUR", "USD", on)).rate, 1.05);
    await assert.rejects(lookupRate(companyId, "GBP", "USD", on), /No exchange rate available/);
  });

  test("a pass covers every company that hasn't turned rates off, and fetches only when one needs them", async () => {
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      fetched.push(String(input));
      return new Response(HISTORY, { status: 200 });
    }) as typeof fetch;
    try {
      // No settings row, so on by default, and a customer billed in EUR.
      const fresh = await insert(Company, {
        name: "Fresh",
        slug: randomUUID(),
        ownerId: actingUserId,
      });
      await insert(Customer, {
        companyId: fresh.id,
        name: "Wayne",
        slug: "wayne",
        email: "ap@wayne.example",
        currency: "EUR",
      });
      // Turned off, with a EUR customer of its own.
      const off = await insert(Company, { name: "Off", slug: randomUUID(), ownerId: actingUserId });
      await insert(CompanyFinanceSettings, {
        companyId: off.id,
        homeCurrency: "USD",
        automaticExchangeRates: false,
        invoiceCcEmails: [],
      });
      await insert(Customer, {
        companyId: off.id,
        name: "Wayne",
        slug: "wayne",
        email: "ap@wayne.example",
        currency: "EUR",
      });

      assert.equal(await refreshExchangeRates(), 4 + 2);
      assert.equal(fetched.length, 1);
      const rows = AppDataSource.getRepository(ExchangeRate);
      assert.equal(await rows.countBy({ companyId: fresh.id }), 2);
      assert.equal(await rows.countBy({ companyId: off.id }), 0);

      // Nobody left who deals in another currency: nothing to fetch.
      await AppDataSource.getRepository(Currency).delete({ companyId });
      await AppDataSource.getRepository(Customer).delete({ companyId: fresh.id });
      assert.equal(await refreshExchangeRates(), 0);
      assert.equal(fetched.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the overview gives the rate each currency converts at today", async () => {
    await fillCompanyRates(companyId, parseEcbRates(HISTORY));
    const overview = await exchangeRateOverview(companyId, new Date("2026-10-23T12:00:00.000Z"));
    assert.equal(overview.homeCurrency, "USD");
    assert.deepEqual(overview.automatic, {
      enabled: true,
      available: true,
      latestDate: "2026-10-22",
    });
    assert.deepEqual(
      overview.rates.map((rate) => [
        rate.currency,
        rate.rate,
        rate.date?.slice(0, 10) ?? null,
        rate.automatic,
      ]),
      [
        ["EUR", 1.1205, "2026-10-22", true],
        ["GBP", 1.33759, "2026-10-22", true],
        ["JPY", null, null, false],
      ],
    );
  });
});
