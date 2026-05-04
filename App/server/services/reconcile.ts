import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { decryptConnectionConfig } from "./integrations.js";

/**
 * Reconciliation service. Phase D of the Finance milestone (M19) — see
 * ROADMAP.md.
 *
 * Three responsibilities:
 *   1. Ingest bank lines (Stripe payouts pull or CSV upload).
 *   2. Auto-match obvious cases — same amount and date within ±3 days
 *      of an unmatched `InvoicePayment`, when there's exactly one
 *      candidate.
 *   3. Manual match / unmatch from the UI.
 *
 * Match outcomes are stored on the `BankTransaction` row itself
 * (`matchedPaymentId`, `matchedLedgerEntryId`, `reconciledAt`); we
 * don't post any ledger entries here. The payment/entry was already
 * posted by Phase B's invoice flow — reconciliation just records that
 * we've seen the bank's side of the same money.
 */

const STRIPE_API = "https://api.stripe.com/v1";
const MATCH_DATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// ─────────────────────────── Stripe payouts ────────────────────────────

type StripePayout = {
  id: string;
  amount: number;
  arrival_date: number; // unix seconds
  description?: string;
  statement_descriptor?: string;
  status: string;
  currency: string;
};

type StripePayoutsResponse = {
  data: StripePayout[];
  has_more?: boolean;
};

/**
 * Pull payouts from Stripe and create `BankTransaction` rows for any
 * we haven't seen before. Returns the count of new rows. Idempotent —
 * dedupes on `(feedId, externalId=stripe payout id)`.
 *
 * Phase D fetches the most recent 100 payouts in one call. Pagination
 * lands when a real production install needs it; until then a single
 * page is plenty for a small business that runs reconcile daily.
 */
export async function syncStripePayouts(feed: BankFeed): Promise<number> {
  if (feed.kind !== "stripe_payouts") {
    throw new Error("Feed is not a Stripe payouts feed");
  }
  if (!feed.connectionId) {
    throw new Error("Stripe feed has no connection — pick one first");
  }
  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: feed.connectionId,
    companyId: feed.companyId,
  });
  if (!conn) throw new Error("Stripe connection not found");
  const cfg = decryptConnectionConfig(conn) as { apiKey?: string };
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error("Stripe connection is missing an API key");

  const res = await fetch(`${STRIPE_API}/payouts?limit=100`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Stripe ${res.status}: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text) as StripePayoutsResponse;
  const payouts = parsed.data ?? [];

  const existing = await AppDataSource.getRepository(BankTransaction).find({
    where: { feedId: feed.id },
    select: ["externalId"],
  });
  const seen = new Set(existing.map((b) => b.externalId).filter((x): x is string => !!x));

  const txnRepo = AppDataSource.getRepository(BankTransaction);
  const fresh: BankTransaction[] = [];
  for (const p of payouts) {
    if (seen.has(p.id)) continue;
    fresh.push(
      txnRepo.create({
        companyId: feed.companyId,
        feedId: feed.id,
        externalId: p.id,
        date: new Date(p.arrival_date * 1000),
        amountCents: p.amount,
        description:
          p.description ?? p.statement_descriptor ?? `Stripe payout ${p.id}`,
        reference: p.id,
        raw: JSON.stringify(p),
      }),
    );
  }
  if (fresh.length > 0) {
    await txnRepo.save(fresh);
  }
  feed.lastSyncAt = new Date();
  await AppDataSource.getRepository(BankFeed).save(feed);
  return fresh.length;
}

// ─────────────────────────── CSV import ────────────────────────────────

/**
 * Parse a CSV body into bank-transaction-shaped objects, then dedupe
 * against existing rows for this feed by `(date, amount, description)`
 * triple. Returns the count of new rows inserted.
 *
 * Tolerates the column-name variants real banks use. Strict about the
 * structural bits (must have a header row, must have a date and an
 * amount column).
 */
export async function importBankCsv(
  feed: BankFeed,
  csvText: string,
): Promise<{ inserted: number; skipped: number }> {
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    throw new Error("CSV needs a header row plus at least one data row");
  }
  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const dateIdx = findColumn(headers, ["date", "transaction date", "posting date"]);
  const amountIdx = findColumn(headers, ["amount", "transaction amount", "value"]);
  const descIdx = findColumn(headers, ["description", "memo", "details", "narrative"]);
  const refIdx = findColumn(headers, ["reference", "ref", "transaction id"]);
  if (dateIdx < 0 || amountIdx < 0) {
    throw new Error("CSV needs at least date and amount columns");
  }

  const existing = await AppDataSource.getRepository(BankTransaction).find({
    where: { feedId: feed.id },
    select: ["date", "amountCents", "description"],
  });
  const seenKey = new Set(
    existing.map((b) => `${b.date.toISOString().slice(0, 10)}|${b.amountCents}|${b.description}`),
  );

  const txnRepo = AppDataSource.getRepository(BankTransaction);
  const fresh: BankTransaction[] = [];
  let skipped = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.length === 0 || r.every((c) => !c.trim())) continue;
    const dateStr = r[dateIdx]?.trim();
    const amountStr = r[amountIdx]?.trim();
    if (!dateStr || !amountStr) {
      skipped += 1;
      continue;
    }
    const date = parseDate(dateStr);
    if (!date) {
      skipped += 1;
      continue;
    }
    const cents = parseAmountToCents(amountStr);
    if (cents === null) {
      skipped += 1;
      continue;
    }
    const description = (descIdx >= 0 ? r[descIdx] : "")?.trim() ?? "";
    const reference = (refIdx >= 0 ? r[refIdx] : "")?.trim() ?? "";
    const key = `${date.toISOString().slice(0, 10)}|${cents}|${description}`;
    if (seenKey.has(key)) {
      skipped += 1;
      continue;
    }
    seenKey.add(key);
    fresh.push(
      txnRepo.create({
        companyId: feed.companyId,
        feedId: feed.id,
        externalId: null,
        date,
        amountCents: cents,
        description,
        reference,
        raw: JSON.stringify(r),
      }),
    );
  }
  if (fresh.length > 0) await txnRepo.save(fresh);
  feed.lastSyncAt = new Date();
  await AppDataSource.getRepository(BankFeed).save(feed);
  return { inserted: fresh.length, skipped };
}

function findColumn(headers: string[], candidates: string[]): number {
  for (let i = 0; i < headers.length; i += 1) {
    if (candidates.includes(headers[i])) return i;
  }
  return -1;
}

function parseDate(s: string): Date | null {
  // Accept ISO (2026-05-04), US (05/04/2026), EU (04/05/2026 → ambiguous,
  // we try ISO-style parse first and fall back to splitting on /).
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso;
  const parts = s.split(/[/-]/).map((p) => p.trim());
  if (parts.length === 3) {
    // Default to MM/DD/YYYY (US convention) when the first part looks
    // like a small number ≤12.
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    const c = Number(parts[2]);
    const year = c < 100 ? 2000 + c : c;
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      const d = new Date(Date.UTC(year, a - 1, b));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function parseAmountToCents(s: string): number | null {
  // Strip everything except digits, sign, decimal point. Accept
  // parens-as-negative ("(123.45)") and comma thousand separators.
  const negParens = /^\s*\(.+\)\s*$/.test(s);
  const cleaned = s.replace(/[(),$£€¥\s]/g, "").replace(/[^0-9.\-+]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return negParens ? -Math.abs(cents) : cents;
}

/**
 * Minimal RFC-4180 CSV parser. Handles quoted fields, embedded commas,
 * and escaped double-quotes. Newline detection covers CRLF + LF.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c === "\r") {
      // skip; \n on the next iteration finalizes the row
    } else {
      cell += c;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ─────────────────────────── Matching ──────────────────────────────────

/**
 * Score-and-match unmatched transactions on this feed against
 * unmatched `InvoicePayment` rows. A bank txn is auto-matched when:
 *   - There is exactly one candidate payment with the same
 *     `amountCents` and a `paidAt` within ±3 days.
 *   - That payment is not already matched to another bank txn.
 *
 * Returns the count of newly matched rows. Conservative on purpose
 * — when in doubt, accountants want to see the candidate set, not
 * an auto-decision they have to investigate later.
 */
export async function autoMatchFeed(feed: BankFeed): Promise<number> {
  const txnRepo = AppDataSource.getRepository(BankTransaction);
  const txns = await txnRepo.find({
    where: { feedId: feed.id, reconciledAt: undefined },
  });
  const unmatched = txns.filter((t) => !t.reconciledAt);
  if (unmatched.length === 0) return 0;

  // Pull every payment for this company, then filter in memory. Phase D
  // doesn't have many — likely tens, hundreds for a busy company.
  const allPayments = await AppDataSource.getRepository(InvoicePayment).find({
    where: {
      invoiceId: In(
        (
          await AppDataSource.getRepository(Invoice).find({
            where: { companyId: feed.companyId },
            select: ["id"],
          })
        ).map((inv) => inv.id),
      ),
    },
  });
  const claimed = new Set(
    txns
      .filter((t) => t.matchedPaymentId)
      .map((t) => t.matchedPaymentId as string),
  );
  const candidates = allPayments.filter((p) => !claimed.has(p.id));

  let matched = 0;
  for (const t of unmatched) {
    const tWindow = t.date.getTime();
    const hits = candidates.filter(
      (p) =>
        p.amountCents === t.amountCents &&
        Math.abs(p.paidAt.getTime() - tWindow) <= MATCH_DATE_WINDOW_MS,
    );
    if (hits.length === 1) {
      t.matchedPaymentId = hits[0].id;
      t.matchedLedgerEntryId = null;
      t.reconciledAt = new Date();
      t.reconciledById = null;
      claimed.add(hits[0].id);
      matched += 1;
    }
  }
  if (matched > 0) await txnRepo.save(unmatched.filter((t) => t.reconciledAt));
  return matched;
}

export async function manualMatch(
  txn: BankTransaction,
  target: { paymentId?: string | null; ledgerEntryId?: string | null },
  actorUserId: string | null,
): Promise<BankTransaction> {
  const repo = AppDataSource.getRepository(BankTransaction);
  if (target.paymentId) {
    const p = await AppDataSource.getRepository(InvoicePayment).findOneBy({
      id: target.paymentId,
    });
    if (!p) throw new Error("Payment not found");
    txn.matchedPaymentId = p.id;
    txn.matchedLedgerEntryId = null;
  } else if (target.ledgerEntryId) {
    const e = await AppDataSource.getRepository(LedgerEntry).findOneBy({
      id: target.ledgerEntryId,
      companyId: txn.companyId,
    });
    if (!e) throw new Error("Ledger entry not found");
    txn.matchedLedgerEntryId = e.id;
    txn.matchedPaymentId = null;
  } else {
    throw new Error("Match needs either paymentId or ledgerEntryId");
  }
  txn.reconciledAt = new Date();
  txn.reconciledById = actorUserId;
  return repo.save(txn);
}

export async function unmatch(txn: BankTransaction): Promise<BankTransaction> {
  txn.matchedPaymentId = null;
  txn.matchedLedgerEntryId = null;
  txn.reconciledAt = null;
  txn.reconciledById = null;
  return AppDataSource.getRepository(BankTransaction).save(txn);
}

// ─────────────────────── Match candidates (drill) ──────────────────────

export type MatchCandidate = {
  kind: "payment";
  paymentId: string;
  invoiceNumber: string;
  invoiceSlug: string;
  customerName: string;
  amountCents: number;
  paidAt: string;
  method: string;
  /** 0..1 confidence score from the auto-matcher heuristic. */
  score: number;
};

/**
 * Suggest payment candidates for a given bank transaction, ranked by
 * (amount-equality, date-proximity). Caller decides whether to commit
 * by calling `manualMatch`.
 */
export async function findMatchCandidates(
  txn: BankTransaction,
): Promise<MatchCandidate[]> {
  const invoices = await AppDataSource.getRepository(Invoice).find({
    where: { companyId: txn.companyId },
  });
  const invIds = invoices.map((i) => i.id);
  if (invIds.length === 0) return [];
  const customers = new Map(
    (
      await AppDataSource.getRepository(
        (await import("../db/entities/Customer.js")).Customer,
      ).find({
        where: {
          id: In(invoices.map((i) => i.customerId)),
          companyId: txn.companyId,
        },
        select: ["id", "name"],
      })
    ).map((c) => [c.id, c.name]),
  );
  const allPayments = await AppDataSource.getRepository(InvoicePayment).find({
    where: { invoiceId: In(invIds) },
  });
  const txns = await AppDataSource.getRepository(BankTransaction).find({
    where: { companyId: txn.companyId },
    select: ["matchedPaymentId"],
  });
  const claimed = new Set(
    txns.map((t) => t.matchedPaymentId).filter((x): x is string => !!x),
  );
  const invById = new Map(invoices.map((i) => [i.id, i]));

  const out: MatchCandidate[] = [];
  for (const p of allPayments) {
    if (claimed.has(p.id) && p.id !== txn.matchedPaymentId) continue;
    const inv = invById.get(p.invoiceId);
    if (!inv) continue;
    const amtMatch = p.amountCents === txn.amountCents ? 0.6 : 0;
    const dayDiff =
      Math.abs(p.paidAt.getTime() - txn.date.getTime()) / (24 * 60 * 60 * 1000);
    const dateScore = Math.max(0, 0.4 - 0.05 * dayDiff);
    const score = amtMatch + dateScore;
    if (score <= 0) continue;
    out.push({
      kind: "payment",
      paymentId: p.id,
      invoiceNumber: inv.number || "(draft)",
      invoiceSlug: inv.slug,
      customerName: customers.get(inv.customerId) ?? "—",
      amountCents: p.amountCents,
      paidAt: p.paidAt.toISOString(),
      method: p.method,
      score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 25);
}
