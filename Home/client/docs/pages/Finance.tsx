import {
  Code,
  DocLink,
  H2,
  H3,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Finance() {
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Finance"
        lead={
          <>
            Native invoicing, quoting, expense tracking, and a real
            double-entry general ledger — built into Genosyn so AI
            Employees can read and write the same books a human accountant
            uses. Find it in the sidebar under <Code>Finance</Code>.
          </>
        }
      />

      <H2 id="what-ships">What ships</H2>
      <UL>
        <LI>
          <Strong>Estimates</Strong> — quotations issued to customers
          before a sale. Convert any accepted estimate into an invoice in
          one click.
        </LI>
        <LI>
          <Strong>Invoices</Strong> — billable documents with line items,
          tax snapshots, payments, and email / print-to-PDF rendering.
        </LI>
        <LI>
          <Strong>Bills</Strong> — the AP mirror of invoices, for what
          your company owes vendors.
        </LI>
        <LI>
          <Strong>Customers</Strong> and <Strong>Vendors</Strong> —
          counterparties for sales and purchases, each with billing
          details, tax IDs, and a default currency.
        </LI>
        <LI>
          <Strong>Catalog</Strong> — reusable <Code>Products</Code> and{" "}
          <Code>Tax rates</Code>, snapshotted onto every line so editing
          a product never rewrites historical documents.
        </LI>
        <LI>
          <Strong>Ledger</Strong> — chart of accounts, journal entries,
          trial balance, P&amp;L / balance sheet / cash flow reports,
          bank-feed reconciliation, and accounting periods.
        </LI>
      </UL>

      <H2 id="estimates">Estimates (quotations)</H2>
      <P>
        Estimates are pre-sale documents — proposed line items with
        prices, sent to a customer for sign-off. They do not affect the
        general ledger; only the invoice that an estimate converts into
        does.
      </P>

      <H3 id="estimates-lifecycle">Lifecycle</H3>
      <OL>
        <LI>
          <Strong>Draft</Strong> — fully editable. Click{" "}
          <Code>New estimate</Code>, pick a customer, add line items,
          save. The slug looks like <Code>edraft-xxxxxx</Code> until
          issue.
        </LI>
        <LI>
          <Strong>Sent</Strong> — clicking <Code>Issue</Code> (or{" "}
          <Code>Issue &amp; send</Code> to email the customer) mints a
          gapless number like <Code>EST-0001</Code> and locks the line
          items. The URL slug becomes the lowercased number.
        </LI>
        <LI>
          <Strong>Accepted</Strong> / <Strong>Declined</Strong> — record
          the customer&apos;s response from the detail page. Accepted
          estimates can be converted to invoices.
        </LI>
        <LI>
          <Strong>Invoiced</Strong> — once converted, the estimate keeps
          a link to the resulting <Code>INV-####</Code>. The status
          badge flips to <Code>invoiced</Code>; the estimate becomes
          read-only.
        </LI>
        <LI>
          <Strong>Expired</Strong> — a synthetic status shown when{" "}
          <Code>validUntil</Code> has passed and the estimate is still
          in <Code>sent</Code>. Re-issue or void to clear it.
        </LI>
        <LI>
          <Strong>Void</Strong> — terminal cancellation, available on
          any non-draft estimate.
        </LI>
      </OL>

      <H3 id="estimates-convert">Convert to an invoice</H3>
      <P>
        From an accepted (or still-sent) estimate, click{" "}
        <Code>Convert to invoice</Code>. Genosyn copies every line
        verbatim, inherits the customer and currency, creates a draft
        invoice, and immediately issues it — which mints the next{" "}
        <Code>INV-####</Code> and posts the journal entry
        (<Code>DR Accounts Receivable / CR Revenue + Tax Payable</Code>)
        into the ledger. The original estimate stays in the system with
        its <Code>invoiceId</Code> set, so you can always trace which
        quote produced which sale.
      </P>

      <H3 id="estimates-printing">Sending and printing</H3>
      <P>
        Every issued estimate has a Print / PDF view at{" "}
        <Code>/api/companies/:cid/estimates/:slug/html</Code>. Use it
        from the detail page&apos;s <Code>Print / PDF</Code> button —
        <em>File → Save as PDF</em> in your browser produces a clean
        A4 PDF with no app chrome. The same HTML is what the customer
        sees when you click <Code>Issue &amp; send</Code> or{" "}
        <Code>Resend email</Code>, delivered through whichever{" "}
        <DocLink to="/docs/integrations">EmailProvider</DocLink> the
        company has configured.
      </P>

      <H2 id="invoices">Invoices</H2>
      <P>
        The invoice flow mirrors estimates with two extras: a{" "}
        <Code>dueDate</Code> and a payments ledger. Record cash, bank
        transfers, Stripe charges, or other receipts directly on the
        invoice; each payment posts a matching{" "}
        <Code>DR Bank / CR Accounts Receivable</Code> entry. Once the
        cumulative paid amount reaches the invoice total, the status
        flips from <Code>sent</Code> to <Code>paid</Code>.
      </P>

      <H2 id="ledger">Ledger and reports</H2>
      <P>
        Every state change on an invoice or bill emits a journal entry
        into the same ledger you can write to by hand from{" "}
        <Code>Finance → Journal</Code>. The chart of accounts seeds
        sensible defaults on first visit (1100 Bank, 1200 Accounts
        Receivable, 2100 Tax Payable, 4000 Sales Revenue,
        4910 FX Gain, 6900 FX Loss), but you can rename, reparent, or
        add accounts freely as long as you don&apos;t touch the system
        codes the auto-posting depends on. From there, the{" "}
        <Code>Trial balance</Code> and <Code>Reports</Code> pages
        produce the standard accountant outputs (P&amp;L, balance
        sheet, cash flow) with optional period comparisons.
      </P>
    </>
  );
}
