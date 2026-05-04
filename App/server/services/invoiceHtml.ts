import type { Customer } from "../db/entities/Customer.js";
import type { Invoice } from "../db/entities/Invoice.js";
import type { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import type { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { Company } from "../db/entities/Company.js";
import { AppDataSource } from "../db/datasource.js";
import { formatMoney } from "../lib/money.js";

/**
 * Render an Invoice as a self-contained HTML document. Used as both the
 * email body when the user clicks "Send" and the printable view at
 * `/finance/invoices/:slug/print` (browser → "Save as PDF").
 *
 * Inline CSS only — no external assets, no JS, no custom fonts. The
 * stylesheet is print-friendly: A4 size, `@page` margins, two-decimal
 * tabular numerals so columns align cleanly.
 */

export type InvoiceHtmlInput = {
  invoice: Invoice;
  customer: Customer;
  lines: InvoiceLineItem[];
  payments: InvoicePayment[];
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
.invoice-number {
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
.totals .row.balance {
  color: #b45309;
  font-weight: 600;
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
.payments {
  margin-top: 24px;
}
.payments h3 {
  margin: 0 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #64748b;
}
.payments table { font-size: 12px; }
.status {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.status.draft { background: #f1f5f9; color: #475569; }
.status.sent  { background: #e0f2fe; color: #075985; }
.status.paid  { background: #dcfce7; color: #166534; }
.status.void  { background: #fee2e2; color: #991b1b; }
@page { size: A4; margin: 12mm; }
@media print {
  body { background: #fff; }
  .page { margin: 0; padding: 0; max-width: none; box-shadow: none; }
}
`;

/** HTML-escape a string for safe interpolation into element bodies. */
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

export function renderInvoiceHtml(input: InvoiceHtmlInput): string {
  const { invoice, customer, lines, payments } = input;
  const cur = invoice.currency;
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

  const paymentsBlock =
    payments.length > 0
      ? `<div class="payments">
          <h3>Payments received</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th>Reference</th>
                <th class="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${payments
                .map(
                  (p) => `<tr>
                    <td class="num">${fmtDate(p.paidAt)}</td>
                    <td>${esc(p.method)}</td>
                    <td>${esc(p.reference)}</td>
                    <td class="right num">${formatMoney(p.amountCents, p.currency)}</td>
                  </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>`
      : "";

  const notesBlock = invoice.notes
    ? `<div class="notes">${esc(invoice.notes)}</div>`
    : "";
  const footerBlock = invoice.footer
    ? `<div class="footer">${esc(invoice.footer)}</div>`
    : "";

  const numberDisplay = invoice.number || "DRAFT";
  const statusClass = invoice.status;

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
  <title>Invoice ${esc(numberDisplay)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="brand">${esc(input.companyName || "")}</div>
        <div style="margin-top:24px">
          <div class="title">Invoice</div>
          <h1 class="invoice-number">${esc(numberDisplay)}</h1>
          <div style="margin-top:6px"><span class="status ${statusClass}">${esc(invoice.status)}</span></div>
        </div>
      </div>
      <div class="meta">
        <div><strong>Issued:</strong> ${fmtDate(invoice.issueDate)}</div>
        <div><strong>Due:</strong> ${fmtDate(invoice.dueDate)}</div>
        <div><strong>Currency:</strong> ${esc(invoice.currency)}</div>
      </div>
    </div>

    <div class="parties">
      <div>
        <div class="party-label">Bill to</div>
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
      <div class="row"><span>Subtotal</span><span class="num">${formatMoney(invoice.subtotalCents, cur)}</span></div>
      <div class="row"><span>Tax</span><span class="num">${formatMoney(invoice.taxCents, cur)}</span></div>
      <div class="row grand"><span>Total</span><span class="num">${formatMoney(invoice.totalCents, cur)}</span></div>
      ${invoice.paidCents > 0 ? `<div class="row"><span>Paid</span><span class="num">${formatMoney(invoice.paidCents, cur)}</span></div>` : ""}
      ${invoice.balanceCents > 0 ? `<div class="row balance"><span>Balance due</span><span class="num">${formatMoney(invoice.balanceCents, cur)}</span></div>` : ""}
    </div>

    ${notesBlock}
    ${paymentsBlock}
    ${footerBlock}
  </div>
</body>
</html>`;
}

/** Convenience wrapper that loads the company name itself. */
export async function renderInvoiceHtmlForCompany(
  companyId: string,
  invoice: Invoice,
  customer: Customer,
  lines: InvoiceLineItem[],
  payments: InvoicePayment[],
): Promise<string> {
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  return renderInvoiceHtml({
    invoice,
    customer,
    lines,
    payments,
    companyName: company?.name ?? "",
  });
}
