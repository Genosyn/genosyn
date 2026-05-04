import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { trialBalance } from "./ledger.js";

/**
 * Accountant-friendly CSV exports. Phase F of the Finance milestone
 * (M19) — see ROADMAP.md.
 *
 * All amounts are emitted in dollar units with two decimals (`12.34`)
 * even when the source store is integer cents. Values are written
 * unquoted unless they contain a comma, quote, or newline; in that
 * case we wrap and double-up internal quotes (RFC 4180).
 *
 * IIF / Xero-shaped exports are deferred — the plain CSV here is
 * already what most bookkeepers ask for, and the IIF / Xero formats
 * earn their per-platform quirks once a real user requests them.
 */

function csvCell(v: string | number): string {
  const s = String(v);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvLine(values: Array<string | number>): string {
  return values.map(csvCell).join(",") + "\n";
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function isoDate(d: Date | string): string {
  return (typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);
}

// ────────────────────────── Customers ────────────────────────────────

export async function exportCustomersCsv(companyId: string): Promise<string> {
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
  const out: string[] = [];
  out.push(
    csvLine([
      "Name",
      "Email",
      "Phone",
      "Tax number",
      "Currency",
      "Billing address",
      "Notes",
      "Archived",
      "Created",
    ]),
  );
  for (const c of customers) {
    out.push(
      csvLine([
        c.name,
        c.email,
        c.phone,
        c.taxNumber,
        c.currency,
        c.billingAddress.replace(/\n/g, " · "),
        c.notes.replace(/\n/g, " · "),
        c.archivedAt ? "yes" : "no",
        isoDate(c.createdAt),
      ]),
    );
  }
  return out.join("");
}

// ────────────────────────── Invoices ─────────────────────────────────

export async function exportInvoicesCsv(
  companyId: string,
  from: Date | null,
  to: Date | null,
): Promise<string> {
  const invoices = await AppDataSource.getRepository(Invoice).find({
    where: { companyId },
    order: { issueDate: "ASC" },
  });
  const filtered = invoices.filter((i) => {
    const t = i.issueDate.getTime();
    if (from && t < from.getTime()) return false;
    if (to && t > to.getTime()) return false;
    return true;
  });
  const customerIds = [...new Set(filtered.map((i) => i.customerId))];
  const customers = customerIds.length
    ? await AppDataSource.getRepository(Customer).find({
        where: { id: In(customerIds), companyId },
        select: ["id", "name", "email"],
      })
    : [];
  const custById = new Map(customers.map((c) => [c.id, c]));
  const out: string[] = [];
  out.push(
    csvLine([
      "Number",
      "Status",
      "Issue date",
      "Due date",
      "Customer",
      "Customer email",
      "Currency",
      "Subtotal",
      "Tax",
      "Total",
      "Paid",
      "Balance",
    ]),
  );
  for (const i of filtered) {
    const c = custById.get(i.customerId);
    out.push(
      csvLine([
        i.number || "(draft)",
        i.status,
        isoDate(i.issueDate),
        isoDate(i.dueDate),
        c?.name ?? "",
        c?.email ?? "",
        i.currency,
        dollars(i.subtotalCents),
        dollars(i.taxCents),
        dollars(i.totalCents),
        dollars(i.paidCents),
        dollars(i.balanceCents),
      ]),
    );
  }
  return out.join("");
}

// ────────────────────────── General journal ──────────────────────────

export async function exportJournalCsv(
  companyId: string,
  from: Date | null,
  to: Date | null,
): Promise<string> {
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { companyId },
    select: ["id", "code", "name"],
  });
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const entries = await AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId },
    order: { date: "ASC", createdAt: "ASC" },
  });
  const filtered = entries.filter((e) => {
    const t = e.date.getTime();
    if (from && t < from.getTime()) return false;
    if (to && t > to.getTime()) return false;
    return true;
  });
  if (filtered.length === 0) {
    return csvLine(["Date", "Source", "Memo", "Account", "Account name", "Debit", "Credit"]);
  }
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { ledgerEntryId: In(filtered.map((e) => e.id)) },
    order: { sortOrder: "ASC" },
  });
  const linesByEntry = new Map<string, LedgerLine[]>();
  for (const l of lines) {
    const arr = linesByEntry.get(l.ledgerEntryId) ?? [];
    arr.push(l);
    linesByEntry.set(l.ledgerEntryId, arr);
  }
  const out: string[] = [];
  out.push(
    csvLine([
      "Date",
      "Source",
      "Memo",
      "Account",
      "Account name",
      "Debit",
      "Credit",
    ]),
  );
  for (const e of filtered) {
    const ls = linesByEntry.get(e.id) ?? [];
    for (const l of ls) {
      const a = acctById.get(l.accountId);
      out.push(
        csvLine([
          isoDate(e.date),
          e.source,
          e.memo,
          a?.code ?? "",
          a?.name ?? "",
          l.debitCents > 0 ? dollars(l.debitCents) : "",
          l.creditCents > 0 ? dollars(l.creditCents) : "",
        ]),
      );
    }
  }
  return out.join("");
}

// ────────────────────────── Trial balance ────────────────────────────

export async function exportTrialBalanceCsv(
  companyId: string,
  asOf: Date,
): Promise<string> {
  const rows = await trialBalance(companyId, asOf);
  const out: string[] = [];
  out.push(csvLine(["Code", "Account", "Type", "Debit", "Credit", "Balance"]));
  for (const r of rows) {
    out.push(
      csvLine([
        r.account.code,
        r.account.name,
        r.account.type,
        dollars(r.debitCents),
        dollars(r.creditCents),
        dollars(r.balanceCents),
      ]),
    );
  }
  return out.join("");
}
