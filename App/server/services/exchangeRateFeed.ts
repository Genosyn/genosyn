import { In, MoreThanOrEqual, type EntityTarget, type ObjectLiteral } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Bill } from "../db/entities/Bill.js";
import { Company } from "../db/entities/Company.js";
import { CompanyFinanceSettings } from "../db/entities/CompanyFinanceSettings.js";
import { Currency } from "../db/entities/Currency.js";
import { Customer } from "../db/entities/Customer.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { Vendor } from "../db/entities/Vendor.js";
import { DEFAULT_CURRENCY } from "../lib/money.js";
import { rateOnFile } from "./fx.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/**
 * Automatic exchange rates: the European Central Bank's euro foreign exchange
 * reference rates, filled into each company's exchange rates so a foreign
 * currency invoice, bill or payment converts without anyone typing a rate.
 *
 * - **The source** is the ECB's own feed at a fixed URL: the official
 *   reference rates for about thirty currencies against the euro, published
 *   around 16:00 CET on each TARGET business day. No key and no third party.
 *   Every pass reads the last 90 days, so a gap left by downtime fills itself.
 * - **Cross rates.** The ECB quotes everything per euro, so the rate between
 *   two other currencies is one quote over the other (GBP → USD is the USD
 *   quote over the GBP quote), kept to six significant figures, one more
 *   than the ECB publishes.
 * - **What gets a rate**: every currency the company deals in — its catalog,
 *   and any its customers, vendors, invoices, bills or schedules use — into
 *   its home currency, one row per reference day, dated the day it is for.
 *   A weekend or holiday has none; the lookup's walk-back uses the last
 *   business day's, as it always has.
 * - **A person wins.** A day that already has a rate — one a person set, or
 *   one a pass fetched before — is never written over. A rate set by hand
 *   overrides the ECB for its day, and a fetched rate never changes once a
 *   document may have locked it (`services/fx.ts` explains the locks).
 * - **On by default**, per company (`CompanyFinanceSettings.automaticExchangeRates`).
 *   Off, passes skip the company and lookups skip the rates fetched before.
 *
 * A pass runs shortly after boot and then every three hours, under a
 * scheduler lease so one replica fetches. A failed fetch changes nothing and
 * is tried again on the next pass; Finance → Currencies has Update now.
 */

/** The ECB's reference rates for the last 90 days. The URL is fixed here, never taken from a request. */
export const ECB_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

/** What a fetched rate's `source` says. */
export const ECB_SOURCE = "ECB";

/**
 * The currencies the ECB publishes, the euro included, as of 2026. Only the
 * page uses this, to say when a home currency has no ECB rate; a pass reads
 * what the feed itself contains.
 */
export const ECB_CURRENCIES: ReadonlySet<string> = new Set([
  "EUR",
  "USD",
  "JPY",
  "CZK",
  "DKK",
  "GBP",
  "HUF",
  "PLN",
  "RON",
  "SEK",
  "CHF",
  "ISK",
  "NOK",
  "TRY",
  "AUD",
  "BRL",
  "CAD",
  "CNY",
  "HKD",
  "IDR",
  "ILS",
  "INR",
  "KRW",
  "MXN",
  "MYR",
  "NZD",
  "PHP",
  "SGD",
  "THB",
  "ZAR",
]);

const PASS_INTERVAL_MS = 3 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
/** The 90-day feed is about 70 KB; anything this large is not it. */
const MAX_FEED_CHARS = 5_000_000;
const INSERT_CHUNK = 200;

/** One reference day: units of each currency per euro, the euro itself at 1. */
export type ReferenceDay = { date: string; perEuro: ReadonlyMap<string, number> };

/** A fetch or a feed that failed, in words a person can act on. */
export class ExchangeRateFeedError extends Error {}

/**
 * Read the ECB's XML into reference days, newest first. Strict about shape: a
 * day needs a real `YYYY-MM-DD` date, a rate needs a three-letter code and a
 * positive number, and anything else in the document is ignored. The daily
 * file quotes its attributes with `'` and the history files with `"`, so
 * either is accepted.
 */
export function parseEcbRates(xml: string): ReferenceDay[] {
  const days: ReferenceDay[] = [];
  const dayPattern = /<Cube\s+time=(["'])(\d{4}-\d{2}-\d{2})\1\s*>([\s\S]*?)<\/Cube>/g;
  const ratePattern = /<Cube\s+currency=(["'])([A-Z]{3})\1\s+rate=(["'])(\d+(?:\.\d+)?)\3\s*\/>/g;
  for (const day of xml.matchAll(dayPattern)) {
    const date = day[2];
    const start = dayStart(date);
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== date) continue;
    const perEuro = new Map<string, number>([["EUR", 1]]);
    for (const quote of day[3].matchAll(ratePattern)) {
      const rate = Number(quote[4]);
      if (Number.isFinite(rate) && rate > 0) perEuro.set(quote[2], rate);
    }
    if (perEuro.size > 1) days.push({ date, perEuro });
  }
  return days.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Units of `to` for one `from` on a reference day, through the euro, to six
 * significant figures. Null when the ECB doesn't quote either currency.
 */
export function rateBetween(day: ReferenceDay, from: string, to: string): number | null {
  const fromPerEuro = day.perEuro.get(from.toUpperCase());
  const toPerEuro = day.perEuro.get(to.toUpperCase());
  if (fromPerEuro === undefined || toPerEuro === undefined) return null;
  return Number((toPerEuro / fromPerEuro).toPrecision(6));
}

/** Midnight UTC of a `YYYY-MM-DD` day, the date a rate for that day is filed under. */
function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch and read the ECB's last 90 days of reference rates. */
export async function fetchReferenceRates(signal?: AbortSignal): Promise<ReferenceDay[]> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let body: string;
  try {
    const response = await fetch(ECB_RATES_URL, {
      headers: { Accept: "application/xml, text/xml" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new ExchangeRateFeedError(
        `The European Central Bank's rates aren't available right now (HTTP ${response.status}).`,
      );
    }
    body = await response.text();
  } catch (err) {
    if (err instanceof ExchangeRateFeedError) throw err;
    throw new ExchangeRateFeedError(
      `Couldn't reach the European Central Bank for its rates: ${messageOf(err)}`,
    );
  }
  const days = body.length > MAX_FEED_CHARS ? [] : parseEcbRates(body);
  if (days.length === 0) {
    throw new ExchangeRateFeedError(
      "The European Central Bank's feed had no rates Genosyn could read.",
    );
  }
  return days;
}

/**
 * Every currency a company deals in: its catalog, and any its customers,
 * vendors, invoices, bills or recurring invoices use. Upper-case and sorted.
 */
export async function currenciesInUse(companyId: string): Promise<string[]> {
  const codes = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && /^[A-Za-z]{3}$/.test(value)) codes.add(value.toUpperCase());
  };
  const catalog = await AppDataSource.getRepository(Currency).find({
    where: { companyId },
    select: ["code"],
  });
  for (const currency of catalog) add(currency.code);
  const documents: EntityTarget<ObjectLiteral>[] = [
    Customer,
    Vendor,
    Invoice,
    Bill,
    RecurringInvoice,
  ];
  for (const entity of documents) {
    const rows = await AppDataSource.getRepository(entity)
      .createQueryBuilder("row")
      .select("DISTINCT row.currency", "currency")
      .where("row.companyId = :companyId", { companyId })
      .getRawMany<{ currency: string }>();
    for (const row of rows) add(row.currency);
  }
  return [...codes].sort();
}

/**
 * Fill one company's automatic rates from `days`: each currency it deals in
 * that the ECB quotes, into its home currency, for every reference day that
 * has no rate yet in either direction. Returns how many rates it added; none
 * while the company has automatic rates off or the ECB doesn't quote its
 * home currency.
 */
export async function fillCompanyRates(companyId: string, days: ReferenceDay[]): Promise<number> {
  if (days.length === 0) return 0;
  const settings = await AppDataSource.getRepository(CompanyFinanceSettings).findOne({
    where: { companyId },
    select: ["homeCurrency", "automaticExchangeRates"],
  });
  if (settings && !settings.automaticExchangeRates) return 0;
  const home = (settings?.homeCurrency || DEFAULT_CURRENCY).toUpperCase();
  const currencies = (await currenciesInUse(companyId)).filter((code) => code !== home);
  if (currencies.length === 0) return 0;

  const oldest = dayStart(days[days.length - 1].date);
  const existing = await AppDataSource.getRepository(ExchangeRate).find({
    where: [
      { companyId, fromCurrency: In(currencies), toCurrency: home, date: MoreThanOrEqual(oldest) },
      { companyId, fromCurrency: home, toCurrency: In(currencies), date: MoreThanOrEqual(oldest) },
    ],
    select: ["fromCurrency", "toCurrency", "date"],
  });
  const taken = new Set(
    existing.map(
      (rate) =>
        `${rate.fromCurrency === home ? rate.toCurrency : rate.fromCurrency}|${dayKey(rate.date)}`,
    ),
  );

  const rows: Array<Partial<ExchangeRate>> = [];
  for (const day of days) {
    for (const code of currencies) {
      if (taken.has(`${code}|${day.date}`)) continue;
      const rate = rateBetween(day, code, home);
      if (rate === null) continue;
      rows.push({
        companyId,
        fromCurrency: code,
        toCurrency: home,
        date: dayStart(day.date),
        rate,
        source: ECB_SOURCE,
        automatic: true,
      });
    }
  }
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    // `orIgnore`: a person's rate saved for the same day in the meantime wins.
    await AppDataSource.getRepository(ExchangeRate)
      .createQueryBuilder()
      .insert()
      .values(rows.slice(i, i + INSERT_CHUNK))
      .orIgnore()
      .execute();
  }
  return rows.length;
}

/**
 * One pass for every company with automatic rates on — which is every company
 * that hasn't turned them off, settings row or not, since on is the default.
 * Fetches only when one of them deals in a currency other than its home one.
 */
export async function refreshExchangeRates(signal?: AbortSignal): Promise<number> {
  const settings = await AppDataSource.getRepository(CompanyFinanceSettings).find({
    select: ["companyId", "homeCurrency", "automaticExchangeRates"],
  });
  const byCompany = new Map(settings.map((row) => [row.companyId, row]));
  const companies = await AppDataSource.getRepository(Company).find({ select: ["id"] });
  const due: string[] = [];
  for (const { id } of companies) {
    const row = byCompany.get(id);
    if (row && !row.automaticExchangeRates) continue;
    const home = (row?.homeCurrency || DEFAULT_CURRENCY).toUpperCase();
    if ((await currenciesInUse(id)).some((code) => code !== home)) due.push(id);
  }
  if (due.length === 0) return 0;
  const days = await fetchReferenceRates(signal);
  let added = 0;
  for (const companyId of due) {
    signal?.throwIfAborted();
    added += await fillCompanyRates(companyId, days);
  }
  return added;
}

/** Fetch now for one company: Update now, and the moment automatic rates are turned on. */
export async function refreshCompanyExchangeRates(
  companyId: string,
): Promise<{ added: number; latestDate: string }> {
  const days = await fetchReferenceRates();
  const added = await fillCompanyRates(companyId, days);
  return { added, latestDate: days[0].date };
}

/** The same, in the background: logged rather than thrown, for a write that shouldn't wait on the ECB. */
export function refreshCompanyExchangeRatesSoon(companyId: string): void {
  void refreshCompanyExchangeRates(companyId).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(
      `[exchange-rates] couldn't fetch rates for company ${companyId}: ${messageOf(err)}`,
    );
  });
}

export type ExchangeRateOverview = {
  homeCurrency: string;
  automatic: {
    enabled: boolean;
    /** Whether the ECB quotes the home currency, so automatic rates can work at all. */
    available: boolean;
    /** The newest reference day the company has a fetched rate for. */
    latestDate: string | null;
  };
  /** The rate each currency in use converts at today, or null where none is on file. */
  rates: Array<{
    currency: string;
    rate: number | null;
    date: string | null;
    source: string | null;
    automatic: boolean;
  }>;
};

/** What Finance → Currencies shows: the setting, and the rate each currency converts at now. */
export async function exchangeRateOverview(
  companyId: string,
  now: Date = new Date(),
): Promise<ExchangeRateOverview> {
  const settings = await AppDataSource.getRepository(CompanyFinanceSettings).findOne({
    where: { companyId },
    select: ["homeCurrency", "automaticExchangeRates"],
  });
  const home = (settings?.homeCurrency || DEFAULT_CURRENCY).toUpperCase();
  const latest = await AppDataSource.getRepository(ExchangeRate).findOne({
    where: { companyId, toCurrency: home, automatic: true },
    order: { date: "DESC" },
    select: ["date"],
  });
  const rates: ExchangeRateOverview["rates"] = [];
  for (const code of await currenciesInUse(companyId)) {
    if (code === home) continue;
    const found = await rateOnFile(companyId, code, home, now);
    rates.push({
      currency: code,
      rate: found?.rate ?? null,
      date: found ? found.date.toISOString() : null,
      source: found?.source ?? null,
      automatic: found?.automatic ?? false,
    });
  }
  return {
    homeCurrency: home,
    automatic: {
      enabled: settings?.automaticExchangeRates ?? true,
      available: ECB_CURRENCIES.has(home),
      latestDate: latest ? dayKey(latest.date) : null,
    },
    rates,
  };
}

let passTimer: ReturnType<typeof setInterval> | null = null;
let passRunning = false;

function runPass(): void {
  if (passRunning) return;
  passRunning = true;
  withSchedulerLease("exchange-rate-feed", PASS_INTERVAL_MS - 60_000, (lease) =>
    refreshExchangeRates(lease.signal),
  )
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(`[exchange-rates] ECB pass failed: ${messageOf(err)}`);
    })
    .finally(() => {
      passRunning = false;
    });
}

export function bootExchangeRateFeed(): void {
  if (passTimer) return;
  runPass();
  passTimer = setInterval(runPass, PASS_INTERVAL_MS);
  if (typeof passTimer.unref === "function") passTimer.unref();
}
