import type { Customer } from "../db/entities/Customer.js";
import type { Estimate } from "../db/entities/Estimate.js";
import type { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { Company } from "../db/entities/Company.js";
import { AppDataSource } from "../db/datasource.js";
import { formatMoney } from "../lib/money.js";

/**
 * Render an Estimate as a self-contained HTML document. Used as both
 * the email body when the user clicks "Send" and the printable view
 * served at `/api/.../estimates/:slug/html` (browser → "Save as PDF").
 *
 * Inline CSS only — no external assets, no JS, no custom fonts. The
 * stylesheet is print-friendly: A4 size, `@page` margins, two-decimal
 * tabular numerals so columns align cleanly. Lifted from
 * `invoiceHtml.ts` with the labels swapped from "Invoice" / "Bill to"
 * to "Estimate" / "Prepared for".
 */

export type EstimateHtmlInput = {
  estimate: Estimate;
  customer: Customer;
  lines: EstimateLineItem[];
  /** Optional company override so callers that already have it don't
   *  pay for a second query. */
  companyName?: string;
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
.brand {
  font-size: 20px;
  font-weight: 600;
  color: #0f172a;
}
.title {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #64748b;
  font-size: 11px;
  margin-bottom: 4px;
}
.estimate-number {
  font-size: 22px;
  font-weight: 600;
  color: #0f172a;
  margin: 0;
}
.meta {
  text-align: right;
  font-size: 12px;
  color: #475569;
}
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
.party-name {
  font-weight: 600;
  font-size: 14px;
  color: #0f172a;
  margin-bottom: 4px;
}
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
  padding: 10px 6px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}
.right { text-align: right; }
.num { font-variant-numeric: tabular-nums; }
.totals {
  width: 280px;
  margin-left: auto;
  margin-top: 16px;
}
.totals .row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 13px;
  color: #475569;
}
.totals .row.grand {
  border-top: 2px solid #0f172a;
  margin-top: 6px;
  padding-top: 10px;
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
}
.notes, .footer {
  margin-top: 32px;
  padding: 16px;
  background: #f8fafc;
  border-radius: 8px;
  white-space: pre-wrap;
  color: #334155;
}
.footer {
  background: transparent;
  padding: 0 4px;
  text-align: center;
  font-size: 11px;
  color: #64748b;
  border-top: 1px solid #e2e8f0;
  padding-top: 16px;
  margin-top: 48px;
}
.status {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.status.draft    { background: #f1f5f9; color: #475569; }
.status.sent     { background: #e0f2fe; color: #075985; }
.status.accepted { background: #dcfce7; color: #166534; }
.status.declined { background: #fee2e2; color: #991b1b; }
.status.void     { background: #fee2e2; color: #991b1b; }
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

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}

export function renderEstimateHtml(input: EstimateHtmlInput): string {
  const { estimate, customer, lines } = input;
  const cur = estimate.currency;
  const lineRows = lines
    .map((l) => {
      const qty = fmtQty(l.quantity);
      const unit = formatMoney(l.unitPriceCents, cur);
      const total = formatMoney(l.lineTotalCents, cur);
      const taxLabel =
        l.taxPercent > 0
          ? `${l.taxName || "Tax"} ${l.taxPercent}%${l.taxInclusive ? " incl." : ""}`
          : "";
      return `<tr>
        <td>${esc(l.description)}${taxLabel ? `<div style="color:#94a3b8;font-size:11px;margin-top:2px">${esc(taxLabel)}</div>` : ""}</td>
        <td class="right num">${qty}</td>
        <td class="right num">${unit}</td>
        <td class="right num">${total}</td>
      </tr>`;
    })
    .join("");

  const notesBlock = estimate.notes
    ? `<div class="notes">${esc(estimate.notes)}</div>`
    : "";
  const footerBlock = estimate.footer
    ? `<div class="footer">${esc(estimate.footer)}</div>`
    : "";

  const numberDisplay = estimate.number || "DRAFT";
  const statusClass = estimate.status;

  const billingAddress = customer.billingAddress
    ? `<div class="party-detail">${esc(customer.billingAddress)}</div>`
    : "";
  const taxNumber = customer.taxNumber
    ? `<div class="party-detail">Tax #: ${esc(customer.taxNumber)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Estimate ${esc(numberDisplay)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="brand">${esc(input.companyName || "")}</div>
        <div style="margin-top:24px">
          <div class="title">Estimate</div>
          <h1 class="estimate-number">${esc(numberDisplay)}</h1>
          <div style="margin-top:6px"><span class="status ${statusClass}">${esc(estimate.status)}</span></div>
        </div>
      </div>
      <div class="meta">
        <div><strong>Issued:</strong> ${fmtDate(estimate.issueDate)}</div>
        <div><strong>Valid until:</strong> ${fmtDate(estimate.validUntil)}</div>
        <div><strong>Currency:</strong> ${esc(estimate.currency)}</div>
      </div>
    </div>

    <div class="parties">
      <div>
        <div class="party-label">Prepared for</div>
        <div class="party-name">${esc(customer.name)}</div>
        ${customer.email ? `<div class="party-detail">${esc(customer.email)}</div>` : ""}
        ${billingAddress}
        ${taxNumber}
      </div>
      <div>
        <div class="party-label">From</div>
        <div class="party-name">${esc(input.companyName || "")}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:55%">Description</th>
          <th class="right" style="width:10%">Qty</th>
          <th class="right" style="width:17%">Unit</th>
          <th class="right" style="width:18%">Amount</th>
        </tr>
      </thead>
      <tbody>${lineRows || `<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:24px">No line items</td></tr>`}</tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Subtotal</span><span class="num">${formatMoney(estimate.subtotalCents, cur)}</span></div>
      <div class="row"><span>Tax</span><span class="num">${formatMoney(estimate.taxCents, cur)}</span></div>
      <div class="row grand"><span>Total</span><span class="num">${formatMoney(estimate.totalCents, cur)}</span></div>
    </div>

    ${notesBlock}
    ${footerBlock}
  </div>
</body>
</html>`;
}

/** Convenience wrapper that loads the company name itself. */
export async function renderEstimateHtmlForCompany(
  companyId: string,
  estimate: Estimate,
  customer: Customer,
  lines: EstimateLineItem[],
): Promise<string> {
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  return renderEstimateHtml({
    estimate,
    customer,
    lines,
    companyName: company?.name ?? "",
  });
}
