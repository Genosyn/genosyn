import { AppDataSource } from "../db/datasource.js";
import { CompanyFinanceSettings } from "../db/entities/CompanyFinanceSettings.js";
import { Currency } from "../db/entities/Currency.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
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
 *   4. Convert cent amounts between currencies, throwing when a rate
 *      is missing for a foreign-currency conversion (the auto-post
 *      hooks turn this into a "set up an exchange rate" 400 to the UI).
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
    s = await repo.save(repo.create({ companyId, homeCurrency: "USD" }));
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
  s.homeCurrency = homeCurrency.toUpperCase();
  return repo.save(s);
}

// ────────────────────────── Rate lookups ──────────────────────────────

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
  const repo = AppDataSource.getRepository(ExchangeRate);
  // Pull every rate for this pair, then walk back from the requested
  // date to the most recent on-or-before in memory. Two reasons over
  // pushing the bound into the WHERE clause: simpler portability
  // across sqlite/postgres, and the per-pair list is tiny in practice
  // (one rate per business day).
  const direct = await repo.find({
    where: { companyId, fromCurrency: f, toCurrency: t },
    order: { date: "DESC" },
  });
  const directHit = direct.find((r) => r.date.getTime() <= date.getTime());
  if (directHit) {
    return { rate: directHit.rate, sourceDate: directHit.date };
  }
  // Try the reverse rate as an inverse fallback.
  const inverse = await repo.find({
    where: { companyId, fromCurrency: t, toCurrency: f },
    order: { date: "DESC" },
  });
  const inverseHit = inverse.find(
    (r) => r.date.getTime() <= date.getTime() && r.rate !== 0,
  );
  if (inverseHit) {
    return { rate: 1 / inverseHit.rate, sourceDate: inverseHit.date };
  }
  throw new Error(
    `No exchange rate available for ${f} → ${t} on or before ${date.toISOString().slice(0, 10)}. Add one under Finance → Currencies.`,
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
  return { converted: roundHalfAway(cents * rate), rate };
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
    }),
  );
}
