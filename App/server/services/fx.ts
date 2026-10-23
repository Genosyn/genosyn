import { LessThanOrEqual, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import type { Bill } from "../db/entities/Bill.js";
import { CompanyFinanceSettings } from "../db/entities/CompanyFinanceSettings.js";
import { Currency } from "../db/entities/Currency.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import type { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { roundHalfAway } from "../lib/money.js";
import { seedChartOfAccounts } from "./ledger.js";

/**
 * FX + multi-currency service. Phase E of the Finance milestone (M19) —
 * see ROADMAP.md.
 *
 * Responsibilities:
 *   1. Read/write per-company `CompanyFinanceSettings` (home currency).
 *   2. Seed the standard currency catalog on first read.
 *   3. Look up an `ExchangeRate` by date with walk-back semantics —
 *      the most recent rate on or before the requested date wins.
 *      Rates come from a person or, while a company has automatic rates
 *      on, from the ECB (`services/exchangeRateFeed.ts`).
 *   4. Convert cent amounts between currencies, throwing when a rate
 *      is missing for a foreign-currency conversion (the auto-post
 *      hooks turn this into a "set up an exchange rate" 400 to the UI).
 *   5. Read the rate a document was booked at. An invoice or bill locks
 *      its rate when issued and a payment locks the rate of its day, so
 *      everything that later clears a receivable or payable converts at
 *      the rate it was booked at, whatever rates arrive afterwards.
 */

// Standard catalog seeded on first visit. Add more as needed; users
// can also create their own.
export const SEED_CURRENCIES: ReadonlyArray<{
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
}> = [
  { code: "USD", name: "US Dollar", symbol: "$", decimalPlaces: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimalPlaces: 2 },
  { code: "GBP", name: "British Pound", symbol: "£", decimalPlaces: 2 },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", decimalPlaces: 0 },
  { code: "CAD", name: "Canadian Dollar", symbol: "$", decimalPlaces: 2 },
  { code: "AUD", name: "Australian Dollar", symbol: "$", decimalPlaces: 2 },
  { code: "CHF", name: "Swiss Franc", symbol: "Fr", decimalPlaces: 2 },
  { code: "INR", name: "Indian Rupee", symbol: "₹", decimalPlaces: 2 },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥", decimalPlaces: 2 },
  { code: "BRL", name: "Brazilian Real", symbol: "R$", decimalPlaces: 2 },
];

export async function seedCurrencies(companyId: string): Promise<Currency[]> {
  const repo = AppDataSource.getRepository(Currency);
  const existing = await repo.find({
    where: { companyId },
    select: ["code"],
  });
  const have = new Set(existing.map((c) => c.code));
  const missing = SEED_CURRENCIES.filter((c) => !have.has(c.code));
  if (missing.length > 0) {
    await repo.save(missing.map((c) => repo.create({ companyId, ...c })));
  }
  return repo.find({ where: { companyId }, order: { code: "ASC" } });
}

/**
 * Get-or-create the per-company finance settings row. Lazily ensures
 * the chart of accounts has the FX gain/loss accounts (4910/6900) so
 * the auto-post hooks always have somewhere to land.
 */
export async function getFinanceSettings(
  companyId: string,
): Promise<CompanyFinanceSettings> {
  const repo = AppDataSource.getRepository(CompanyFinanceSettings);
  let s = await repo.findOneBy({ companyId });
  if (!s) {
    s = await repo.save(
      repo.create({ companyId, homeCurrency: "USD", invoiceCcEmails: [] }),
    );
  }
  await ensureFxAccounts(companyId);
  await seedCurrencies(companyId);
  return s;
}

/**
 * Make sure the FX gain/loss accounts exist. Idempotent — uses
 * `seedChartOfAccounts` to plant the base CoA, then adds 4910/6900
 * specifically if they're missing.
 */
async function ensureFxAccounts(companyId: string): Promise<void> {
  const accounts = await seedChartOfAccounts(companyId);
  const have = new Set(accounts.map((a) => a.code));
  const adds: { code: string; name: string; type: "revenue" | "expense" }[] = [];
  if (!have.has("4910")) adds.push({ code: "4910", name: "FX Gain", type: "revenue" });
  if (!have.has("6900")) adds.push({ code: "6900", name: "FX Loss", type: "expense" });
  if (adds.length === 0) return;
  const acctRepo = AppDataSource.getRepository(
    (await import("../db/entities/Account.js")).Account,
  );
  await acctRepo.save(
    adds.map((a) =>
      acctRepo.create({
        companyId,
        code: a.code,
        name: a.name,
        type: a.type,
        isSystem: true,
      }),
    ),
  );
}

export async function setHomeCurrency(
  companyId: string,
  homeCurrency: string,
): Promise<CompanyFinanceSettings> {
  const repo = AppDataSource.getRepository(CompanyFinanceSettings);
  const s = await getFinanceSettings(companyId);
  const next = homeCurrency.toUpperCase();
  // Historical ledger amounts are stored as integer minor units *in the home
  // currency at the time they were posted* — there is no per-row reporting
  // currency to reinterpret. Silently switching the home currency would
  // re-label every past balance (a $1,100 balance sheet reads as "€1,100"),
  // so once anything is on the books the switch is refused. Setting it to the
  // same value stays a harmless no-op.
  if (next !== s.homeCurrency) {
    const posted = await AppDataSource.getRepository(LedgerEntry).count({
      where: { companyId },
    });
    if (posted > 0) {
      throw new Error(
        "Home currency can't be changed once transactions have been posted — " +
          "historical amounts are stored in the original home currency and would be silently re-labeled.",
      );
    }
  }
  s.homeCurrency = next;
  return repo.save(s);
}

/**
 * Update the printable header / footer templates used on every rendered
 * invoice and estimate. Pass undefined to leave a field unchanged so
 * callers can patch them independently.
 */
export async function setFinanceTemplates(
  companyId: string,
  patch: { defaultFromBlock?: string; defaultFooter?: string },
): Promise<CompanyFinanceSettings> {
  const repo = AppDataSource.getRepository(CompanyFinanceSettings);
  const s = await getFinanceSettings(companyId);
  if (patch.defaultFromBlock !== undefined) {
    s.defaultFromBlock = patch.defaultFromBlock;
  }
  if (patch.defaultFooter !== undefined) {
    s.defaultFooter = patch.defaultFooter;
  }
  return repo.save(s);
}

/**
 * Replace the internal recipients copied on every invoice email. The route
 * validates address syntax; the service owns case-insensitive de-duplication
 * so callers outside HTTP get the same durable representation.
 */
export async function setInvoiceCcEmails(
  companyId: string,
  emails: string[],
): Promise<CompanyFinanceSettings> {
  const repo = AppDataSource.getRepository(CompanyFinanceSettings);
  const s = await getFinanceSettings(companyId);
  const seen = new Set<string>();
  s.invoiceCcEmails = emails.flatMap((email) => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
  return repo.save(s);
}

/**
 * Turn the ECB's daily rates on or off for a company. Off keeps the rates
 * already fetched, so the documents and history that used them still read
 * true, but conversions stop using them.
 */
export async function setAutomaticExchangeRates(
  companyId: string,
  on: boolean,
): Promise<CompanyFinanceSettings> {
  const repo = AppDataSource.getRepository(CompanyFinanceSettings);
  const s = await getFinanceSettings(companyId);
  s.automaticExchangeRates = on;
  return repo.save(s);
}

// ────────────────────────── Rate lookups ──────────────────────────────

/**
 * Whether a company takes the ECB's rates. Read without creating the settings
 * row, which `getFinanceSettings` would: a company with none has the default,
 * on.
 */
export async function automaticRatesOn(companyId: string): Promise<boolean> {
  const row = await AppDataSource.getRepository(CompanyFinanceSettings).findOne({
    where: { companyId },
    select: ["automaticExchangeRates"],
  });
  return row?.automaticExchangeRates ?? true;
}

/** The rate on file for `from` → `to` on or before a date, and where it came from. */
export type RateOnFile = {
  rate: number;
  date: Date;
  source: string;
  automatic: boolean;
};

/**
 * The most recent rate on or before `date` for `from` → `to`, or null with
 * none. A direct rate wins over the inverse of the opposite pair. While the
 * company has automatic rates off, the ones fetched before are skipped:
 * off means conversions use only the rates a person set.
 */
export async function rateOnFile(
  companyId: string,
  from: string,
  to: string,
  date: Date,
): Promise<RateOnFile | null> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  const repo = AppDataSource.getRepository(ExchangeRate);
  const automatic = (await automaticRatesOn(companyId)) ? {} : { automatic: false };
  // The most recent usable rate on or before the date, read through the
  // (company, from, to, date) index: with a rate fetched every business day,
  // a pair's history grows by hundreds of rows a year, too many to walk in
  // memory on every conversion. A 0 rate (a fat-fingered entry) is skipped
  // rather than converting every amount to zero.
  const usableBy = (fromCurrency: string, toCurrency: string) =>
    repo.findOne({
      where: {
        companyId,
        fromCurrency,
        toCurrency,
        date: LessThanOrEqual(date),
        rate: MoreThan(0),
        ...automatic,
      },
      order: { date: "DESC" },
    });
  const directHit = await usableBy(f, t);
  if (directHit) {
    return {
      rate: directHit.rate,
      date: directHit.date,
      source: directHit.source,
      automatic: directHit.automatic,
    };
  }
  // Try the reverse rate as an inverse fallback.
  const inverseHit = await usableBy(t, f);
  if (inverseHit) {
    return {
      rate: 1 / inverseHit.rate,
      date: inverseHit.date,
      source: inverseHit.source,
      automatic: inverseHit.automatic,
    };
  }
  return null;
}

/**
 * Look up the rate to convert `from` → `to` on or before `date`.
 * Walks backward from `date` to the most recent matching rate.
 *
 * Returns:
 *   - 1 if `from === to` (identity).
 *   - The matched rate value otherwise.
 *   - Throws when no rate exists.
 */
export async function lookupRate(
  companyId: string,
  from: string,
  to: string,
  date: Date,
): Promise<{ rate: number; sourceDate: Date | null }> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return { rate: 1, sourceDate: null };
  const found = await rateOnFile(companyId, f, t, date);
  if (found) return { rate: found.rate, sourceDate: found.date };
  const fix = (await automaticRatesOn(companyId))
    ? "Click Update now under Finance → Currencies to fetch the ECB's latest rates, or set one there."
    : "Add one under Finance → Currencies.";
  throw new Error(
    `No exchange rate available for ${f} → ${t} on or before ${date.toISOString().slice(0, 10)}. ${fix}`,
  );
}

/**
 * Convert a cent amount from one currency to another. Returns the
 * converted cent amount + the rate used. Same currency → identity.
 */
export async function convertCents(
  companyId: string,
  cents: number,
  from: string,
  to: string,
  date: Date,
): Promise<{ converted: number; rate: number }> {
  if (from.toUpperCase() === to.toUpperCase()) {
    return { converted: cents, rate: 1 };
  }
  const { rate } = await lookupRate(companyId, from, to, date);
  return { converted: convertAtRate(cents, rate), rate };
}

/** Convert at a rate already in hand — one a document locked — rounding as `convertCents` does. */
export function convertAtRate(cents: number, rate: number): number {
  return rate === 1 ? cents : roundHalfAway(cents * rate);
}

// ───────────────────────── Booked rates ───────────────────────────────

/**
 * The rate a posted entry converted its document at, or null. Every line the
 * entry converted from `currency` carries the same rate, so any one will do.
 */
async function postedRate(
  companyId: string,
  source: LedgerEntry["source"],
  sourceRefId: string,
  currency: string,
): Promise<number | null> {
  const entry = await AppDataSource.getRepository(LedgerEntry).findOne({
    where: { companyId, source, sourceRefId },
    select: ["id"],
  });
  if (!entry) return null;
  const line = await AppDataSource.getRepository(LedgerLine).findOne({
    where: { companyId, ledgerEntryId: entry.id, origCurrency: currency, rate: MoreThan(0) },
    select: ["rate"],
  });
  return line?.rate ?? null;
}

/**
 * The rate an issued invoice was booked at, into `home`: what everything that
 * clears its receivable — payments, credits, write-offs — converts at.
 *
 * Locked on the invoice when it was issued. An invoice issued before rates
 * were locked has none, and reads the rate its issue entry used rather than
 * the rate on file for its issue date today, which a rate fetched since can
 * have changed. Only with neither does it fall back to the rate on file.
 */
export async function invoiceBookedRate(
  invoice: Pick<Invoice, "id" | "companyId" | "currency" | "issueDate" | "exchangeRate">,
  home: string,
): Promise<number> {
  if (invoice.currency.toUpperCase() === home.toUpperCase()) return 1;
  if (invoice.exchangeRate && invoice.exchangeRate > 0) return invoice.exchangeRate;
  const posted = await postedRate(invoice.companyId, "invoice_issue", invoice.id, invoice.currency);
  if (posted !== null) return posted;
  return (await lookupRate(invoice.companyId, invoice.currency, home, invoice.issueDate)).rate;
}

/** The rate an issued bill was booked at, into `home`, read as {@link invoiceBookedRate} reads an invoice's. */
export async function billBookedRate(
  bill: Pick<Bill, "id" | "companyId" | "currency" | "issueDate" | "exchangeRate">,
  home: string,
): Promise<number> {
  if (bill.currency.toUpperCase() === home.toUpperCase()) return 1;
  if (bill.exchangeRate && bill.exchangeRate > 0) return bill.exchangeRate;
  const posted = await postedRate(bill.companyId, "manual", `bill_issue:${bill.id}`, bill.currency);
  if (posted !== null) return posted;
  return (await lookupRate(bill.companyId, bill.currency, home, bill.issueDate)).rate;
}

/**
 * The rate a payment converts at: the one it locked, or the rate on file for
 * the day it was paid. The caller saves it on the payment as it posts, which
 * is the lock: the cash a payment brought in keeps its value in the home
 * currency, whatever rates arrive for that day afterwards.
 */
export async function paymentRate(
  companyId: string,
  payment: { paidAt: Date; exchangeRate: number | null },
  currency: string,
  home: string,
): Promise<number> {
  if (currency.toUpperCase() === home.toUpperCase()) return 1;
  if (payment.exchangeRate && payment.exchangeRate > 0) return payment.exchangeRate;
  return (await lookupRate(companyId, currency, home, payment.paidAt)).rate;
}

export async function setRate(
  companyId: string,
  from: string,
  to: string,
  date: Date,
  rate: number,
  source: string,
): Promise<ExchangeRate> {
  const repo = AppDataSource.getRepository(ExchangeRate);
  const existing = await repo.findOneBy({
    companyId,
    fromCurrency: from.toUpperCase(),
    toCurrency: to.toUpperCase(),
    date,
  });
  if (existing) {
    existing.rate = rate;
    existing.source = source;
    // A person's rate replaces a fetched one for its day, and the feed never
    // writes over it again.
    existing.automatic = false;
    return repo.save(existing);
  }
  return repo.save(
    repo.create({
      companyId,
      fromCurrency: from.toUpperCase(),
      toCurrency: to.toUpperCase(),
      date,
      rate,
      source,
      automatic: false,
    }),
  );
}
