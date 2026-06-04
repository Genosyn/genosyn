import type { Customer } from "../db/entities/Customer.js";
import { Company } from "../db/entities/Company.js";
import { AppDataSource } from "../db/datasource.js";
import { formatMoney } from "../lib/money.js";
import { getFinanceSettings } from "./fx.js";
import type { CustomerStatement } from "./customerStatement.js";

/**
 * Render a customer statement as a self-contained HTML document. Shares the
 * print-friendly conventions of `invoiceHtml.ts` — inline CSS only, no
 * external assets, A4 `@page`, tabular numerals — so the same browser
 * print / `htmlToPdf` path produces a clean PDF.
 */

export type StatementHtmlInput = {
  customer: Customer;
  statement: CustomerStatement;
  /** Company display name, used as the brand/from fallback. */
  companyName?: string;
  /** Multi-line "From" block; falls back to `companyName`. */
  defaultFromBlock?: string;
  /** Footer note (payment terms, remittance details). */
  defaultFooter?: string;
};

const STYLES = `
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #0f172a;
  background: #ffffff;
  font-size: 13px;
  line-height: 1.5;
}
.page {
  max-width: 760px;
  margin: 32px auto;
  padding: 40px 48px;
  background: #fff;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  margin-bottom: 32px;
}
.brand { font-size: 20px; font-weight: 600; color: #0f172a; }
.title {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #64748b;
  font-size: 11px;
  margin-bottom: 4px;
}
.doc-name { font-size: 22px; font-weight: 600; color: #0f172a; margin: 0; }
.meta { text-align: right; font-size: 12px; color: #475569; }
.meta div { margin-top: 2px; }
.parties {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 32px;
  margin-bottom: 32px;
  padding-bottom: 24px;
  border-bottom: 1px solid #e2e8f0;
}
.party-label {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #64748b;
  font-size: 10px;
  margin-bottom: 6px;
}
.party-name { font-weight: 600; font-size: 14px; color: #0f172a; margin-bottom: 4px; }
.party-detail { white-space: pre-line; color: #475569; }
table { width: 100%; border-collapse: collapse; }
thead th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
  border-bottom: 1px solid #cbd5e1;
  padding: 8px 6px;
  font-weight: 600;
}
tbody td {
  padding: 9px 6px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}
tbody tr.opening td { color: #64748b; font-style: italic; }
tbody tr.closing td {
  border-top: 2px solid #0f172a;
  border-bottom: none;
  font-weight: 700;
  color: #0f172a;
  padding-top: 12px;
}
.right { text-align: right; }
.num { font-variant-numeric: tabular-nums; }
.muted { color: #94a3b8; }
.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 28px;
}
.summary .cell {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px 14px;
}
.summary .cell .k {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
}
.summary .cell .v {
  margin-top: 4px;
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}
.summary .cell.due .v { color: #b45309; }
.section-label {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #64748b;
  font-size: 11px;
  font-weight: 600;
  margin: 28px 0 10px;
}
.aging {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}
.aging .bucket {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  text-align: center;
}
.aging .bucket .k {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
}
.aging .bucket .v {
  margin-top: 4px;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}
.aging .bucket.hot { border-color: #fecaca; background: #fef2f2; }
.aging .bucket.hot .v { color: #b91c1c; }
.footer {
  text-align: center;
  font-size: 11px;
  color: #64748b;
  border-top: 1px solid #e2e8f0;
  padding-top: 16px;
  margin-top: 48px;
  white-space: pre-wrap;
}
@page { size: A4; margin: 12mm; }
@media print {
  body { background: #fff; }
  .page { margin: 0; padding: 0; max-width: none; box-shadow: none; }
}
`;

function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderCustomerStatementHtml(input: StatementHtmlInput): string {
  const { customer, statement } = input;
  const cur = statement.currency;
  const money = (cents: number) => formatMoney(cents, cur);

  const periodLabel = statement.fromDate
    ? `${statement.fromDate} → ${statement.toDate}`
    : `Through ${statement.toDate}`;

  const openingRow = `<tr class="opening">
    <td>${esc(statement.fromDate ?? "Start")}</td>
    <td colspan="2">Opening balance</td>
    <td class="right num"></td>
    <td class="right num"></td>
    <td class="right num">${money(statement.openingBalanceCents)}</td>
  </tr>`;

  const txnRows = statement.transactions
    .map(
      (t) => `<tr>
        <td class="num">${esc(t.date)}</td>
        <td>${esc(t.reference) || '<span class="muted">—</span>'}</td>
        <td>${esc(t.description)}</td>
        <td class="right num">${t.chargeCents > 0 ? money(t.chargeCents) : '<span class="muted">—</span>'}</td>
        <td class="right num">${t.paymentCents > 0 ? money(t.paymentCents) : '<span class="muted">—</span>'}</td>
        <td class="right num">${money(t.balanceCents)}</td>
      </tr>`,
    )
    .join("");

  const emptyRow = `<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px">No activity in this period</td></tr>`;

  const closingRow = `<tr class="closing">
    <td colspan="5">Balance due</td>
    <td class="right num">${money(statement.closingBalanceCents)}</td>
  </tr>`;

  const a = statement.aging;
  const agingBlock = `
    <div class="section-label">Outstanding by age</div>
    <div class="aging">
      <div class="bucket"><div class="k">Current</div><div class="v">${money(a.currentCents)}</div></div>
      <div class="bucket"><div class="k">1–30 days</div><div class="v">${money(a.d1to30Cents)}</div></div>
      <div class="bucket"><div class="k">31–60 days</div><div class="v">${money(a.d31to60Cents)}</div></div>
      <div class="bucket"><div class="k">61–90 days</div><div class="v">${money(a.d61to90Cents)}</div></div>
      <div class="bucket${a.d90PlusCents > 0 ? " hot" : ""}"><div class="k">90+ days</div><div class="v">${money(a.d90PlusCents)}</div></div>
    </div>`;

  const billingAddress = customer.billingAddress
    ? `<div class="party-detail">${esc(customer.billingAddress)}</div>`
    : "";
  const taxNumber = customer.taxNumber
    ? `<div class="party-detail">Tax #: ${esc(customer.taxNumber)}</div>`
    : "";

  const footerText = input.defaultFooter || "";
  const footerBlock = footerText ? `<div class="footer">${esc(footerText)}</div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Statement — ${esc(customer.name)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="brand">${esc(input.companyName || "")}</div>
        <div style="margin-top:24px">
          <div class="title">Statement of account</div>
          <h1 class="doc-name">${esc(customer.name)}</h1>
        </div>
      </div>
      <div class="meta">
        <div><strong>Period:</strong> ${esc(periodLabel)}</div>
        <div><strong>Statement date:</strong> ${esc(statement.toDate)}</div>
        <div><strong>Currency:</strong> ${esc(cur)}</div>
      </div>
    </div>

    <div class="parties">
      <div>
        <div class="party-label">Account</div>
        <div class="party-name">${esc(customer.name)}</div>
        ${customer.email ? `<div class="party-detail">${esc(customer.email)}</div>` : ""}
        ${billingAddress}
        ${taxNumber}
      </div>
      <div>
        <div class="party-label">From</div>
        ${
          input.defaultFromBlock
            ? `<div class="party-detail">${esc(input.defaultFromBlock)}</div>`
            : `<div class="party-name">${esc(input.companyName || "")}</div>`
        }
      </div>
    </div>

    <div class="summary">
      <div class="cell"><div class="k">Opening balance</div><div class="v">${money(statement.openingBalanceCents)}</div></div>
      <div class="cell"><div class="k">Invoiced</div><div class="v">${money(statement.totalChargesCents)}</div></div>
      <div class="cell"><div class="k">Paid</div><div class="v">${money(statement.totalPaymentsCents)}</div></div>
      <div class="cell due"><div class="k">Balance due</div><div class="v">${money(statement.closingBalanceCents)}</div></div>
    </div>

    <div class="section-label">Activity</div>
    <table>
      <thead>
        <tr>
          <th style="width:14%">Date</th>
          <th style="width:18%">Reference</th>
          <th style="width:28%">Details</th>
          <th class="right" style="width:13%">Charges</th>
          <th class="right" style="width:13%">Payments</th>
          <th class="right" style="width:14%">Balance</th>
        </tr>
      </thead>
      <tbody>
        ${openingRow}
        ${txnRows || emptyRow}
        ${closingRow}
      </tbody>
    </table>

    ${statement.closingBalanceCents > 0 ? agingBlock : ""}
    ${footerBlock}
  </div>
</body>
</html>`;
}

/** Convenience wrapper that loads the company name + finance templates. */
export async function renderCustomerStatementHtmlForCompany(
  companyId: string,
  customer: Customer,
  statement: CustomerStatement,
): Promise<string> {
  const [company, settings] = await Promise.all([
    AppDataSource.getRepository(Company).findOneBy({ id: companyId }),
    getFinanceSettings(companyId),
  ]);
  return renderCustomerStatementHtml({
    customer,
    statement,
    companyName: company?.name ?? "",
    defaultFromBlock: settings.defaultFromBlock,
    defaultFooter: settings.defaultFooter,
  });
}
