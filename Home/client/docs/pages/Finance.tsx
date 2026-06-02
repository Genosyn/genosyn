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
          <Strong>Recurring invoices</Strong> — invoice templates that
          fire on a repeating schedule (monthly retainers, annual
          licences). Each run materializes a fresh invoice into the
          regular invoice list.
        </LI>
        <LI>
          <Strong>Bills</Strong> — the AP mirror of invoices, for what
          your company owes vendors.
        </LI>
        <LI>
          <Strong>Customers</Strong> and <Strong>Vendors</Strong> —
          counterparties for sales and purchases, each with billing
          details, tax IDs, a default currency, and any number of
          named <Strong>contacts</Strong> (people at that account).
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
          gapless number prefixed with the customer&apos;s slug — e.g.{" "}
          <Code>ACME-CORP-EST-0001</Code> — and locks the line items, so
          two customers&apos; first estimates never both read{" "}
          <Code>EST-0001</Code>. The URL slug becomes the lowercased
          number.
        </LI>
        <LI>
          <Strong>Accepted</Strong> / <Strong>Declined</Strong> — record
          the customer&apos;s response from the detail page. Accepted
          estimates can be converted to invoices.
        </LI>
        <LI>
          <Strong>Invoiced</Strong> — once converted, the estimate keeps
          a link to the resulting invoice. The status badge flips to{" "}
          <Code>invoiced</Code>; the estimate becomes read-only.
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
        invoice, and immediately issues it — which mints the next
        invoice number and posts the journal entry
        (<Code>DR Accounts Receivable / CR Revenue + Tax Payable</Code>)
        into the ledger. The original estimate stays in the system with
        its <Code>invoiceId</Code> set, so you can always trace which
        quote produced which sale.
      </P>

      <H3 id="estimates-duplicate">Duplicate</H3>
      <P>
        Click <Code>Duplicate</Code> on any estimate (from the row menu
        or the detail page) to fork it into a fresh draft. The customer,
        currency, line items, notes, and footer are copied verbatim;{" "}
        <Code>issueDate</Code> resets to today and <Code>validUntil</Code>{" "}
        to thirty days out. The new draft has no number until you issue
        it, and the original is untouched — handy for re-quoting an
        expired estimate or sending the same package to a different
        customer (open the duplicate, switch the customer in edit mode,
        and issue).
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

      <H2 id="customers">Customers and contacts</H2>
      <P>
        A <Strong>Customer</Strong> is the billable account — the
        company name, primary billing email, tax ID, default currency,
        and address that appear on every invoice. Each customer can
        additionally carry any number of <Strong>contacts</Strong>: the
        humans at that account, each with their own name, role,
        email, and phone. Mark one as the primary contact to surface
        it first in the UI. Add, edit, or remove contacts inline on the
        New / Edit customer page in <Code>Finance → Customers</Code>. Each
        customer also has a <Strong>slug</Strong> auto-derived from its
        name (<Code>Acme Corp</Code> → <Code>acme-corp</Code>); that slug
        is uppercased and prefixed onto every invoice and estimate number
        issued to the customer, so the numbers stay unique and
        self-identify across customers.
      </P>

      <H2 id="invoices">Invoices</H2>
      <P>
        The invoice flow mirrors estimates with two extras: a{" "}
        <Code>dueDate</Code> and a payments ledger. Issuing mints the
        same slug-prefixed gapless number estimates use — e.g.{" "}
        <Code>ACME-CORP-INV-0001</Code>. Record cash, bank transfers,
        Stripe charges, or other receipts directly on the invoice; each
        payment posts a matching{" "}
        <Code>DR Bank / CR Accounts Receivable</Code> entry. Once the
        cumulative paid amount reaches the invoice total, the status
        flips from <Code>sent</Code> to <Code>paid</Code>.
      </P>
      <P>
        <Code>Duplicate</Code> works the same way as on estimates —
        from the row menu or the detail page, you can fork any invoice
        (even one that&apos;s already paid or void) into a fresh draft.
        Lines, customer, currency, notes, and footer come along;
        payments and status timestamps do not. The new draft picks up
        <em> today</em> as its issue date and a fourteen-day default due
        date, and stays unnumbered until you issue it.
      </P>

      <H2 id="recurring-invoices">Recurring invoices</H2>
      <P>
        Open <Code>Finance → Recurring</Code> and click{" "}
        <Code>New schedule</Code> to set up a template. Pick a customer,
        choose how often it should bill — every <Strong>week</Strong>,{" "}
        <Strong>month</Strong>, <Strong>quarter</Strong> or{" "}
        <Strong>year</Strong>, on the day and at the time you set — and
        compose the line items just like a normal invoice. A plain-English
        summary (for example{" "}
        <Code>The 1st of every month at 9:00 AM</Code>) appears beneath the
        picker so you can confirm the cadence before saving.
      </P>

      <H3 id="recurring-modes">Draft vs auto-send</H3>
      <P>
        Each schedule has an <Strong>Auto-issue and email</Strong>{" "}
        toggle. Off (the default), every tick lands as a fresh draft —
        you review and click <Code>Send</Code> on each one. On, the
        tick issues the invoice (minting its invoice number and
        posting the AR / Revenue ledger entry) and emails it to the
        customer through the company&apos;s configured EmailProvider —
        same path a human-sent invoice takes, so the email log captures
        it identically.
      </P>

      <H3 id="recurring-controls">Pausing, ending, running now</H3>
      <P>
        From the detail page, <Code>Pause</Code> stops scheduled runs
        without losing the template; <Code>Resume</Code> restarts the
        next tick from now. <Code>End</Code> is terminal — the schedule
        becomes read-only but every invoice it already created stays in
        your books. <Code>Run now</Code> generates an invoice
        immediately without consuming the scheduled slot, useful for
        catch-up runs or testing the template. Optional caps — max
        runs and end date — flip the status to{" "}
        <Code>ended</Code> automatically once hit.
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
