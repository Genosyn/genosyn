import { Code, DocLink, H2, H3, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Finance() {
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Finance"
        lead={
          <>
            Native invoicing, quoting, expense tracking, and a real double-entry general ledger —
            built into Genosyn so AI Employees can read and write the same books a human accountant
            uses. Find it in the sidebar under <Code>Finance</Code>.
          </>
        }
      />

      <H2 id="what-ships">What ships</H2>
      <UL>
        <LI>
          <Strong>Estimates</Strong> — quotations issued to customers before a sale. Convert any
          accepted estimate into an invoice in one click.
        </LI>
        <LI>
          <Strong>Invoices</Strong> — billable documents with line items, tax snapshots, payments,
          and email / print-to-PDF rendering.
        </LI>
        <LI>
          <Strong>Recurring invoices</Strong> — invoice templates that fire on a repeating schedule
          (monthly retainers, annual licences). Each run materializes a fresh invoice into the
          regular invoice list.
        </LI>
        <LI>
          <Strong>Bills</Strong> — the AP mirror of invoices, for what your company owes vendors.
        </LI>
        <LI>
          <Strong>Vendors</Strong> — the counterparties you purchase from, each with billing
          details, a tax ID, and a default currency. (<Strong>Customers</Strong> now live in their
          own <DocLink to="/docs/customers">Customers</DocLink> section.)
        </LI>
        <LI>
          <Strong>Catalog</Strong> — reusable <Code>Products</Code> and <Code>Tax rates</Code>,
          snapshotted onto every line so editing a product never rewrites historical documents.
        </LI>
        <LI>
          <Strong>Ledger</Strong> — chart of accounts, journal entries, trial balance, P&amp;L /
          balance sheet / cash flow reports, bank-feed reconciliation, and accounting periods.
        </LI>
      </UL>

      <H2 id="estimates">Estimates (quotations)</H2>
      <P>
        Estimates are pre-sale documents — proposed line items with prices, sent to a customer for
        sign-off. They do not affect the general ledger; only the invoice that an estimate converts
        into does.
      </P>

      <H3 id="estimates-lifecycle">Lifecycle</H3>
      <OL>
        <LI>
          <Strong>Draft</Strong> — fully editable. Click <Code>New estimate</Code>, pick a customer,
          add line items, save. The slug looks like <Code>edraft-xxxxxx</Code> until issue.
        </LI>
        <LI>
          <Strong>Sent</Strong> — clicking <Code>Issue</Code> (or <Code>Issue &amp; send</Code> to
          email the customer) mints a gapless number prefixed with the customer&apos;s slug — e.g.{" "}
          <Code>ACME-CORP-EST-0001</Code> — and locks the line items, so two customers&apos; first
          estimates never both read <Code>EST-0001</Code>. The URL slug becomes the lowercased
          number.
        </LI>
        <LI>
          <Strong>Accepted</Strong> / <Strong>Declined</Strong> — record the customer&apos;s
          response from the detail page. Accepted estimates can be converted to invoices.
        </LI>
        <LI>
          <Strong>Invoiced</Strong> — once converted, the estimate keeps a link to the resulting
          invoice. The status badge flips to <Code>invoiced</Code>; the estimate becomes read-only.
        </LI>
        <LI>
          <Strong>Expired</Strong> — a synthetic status shown when <Code>validUntil</Code> has
          passed and the estimate is still in <Code>sent</Code>. Re-issue or void to clear it.
        </LI>
        <LI>
          <Strong>Void</Strong> — terminal cancellation, available on any non-draft estimate.
        </LI>
      </OL>

      <H3 id="estimates-convert">Convert to an invoice</H3>
      <P>
        From an accepted (or still-sent) estimate, click <Code>Convert to invoice</Code>. Genosyn
        copies every line verbatim, inherits the customer and currency, creates a draft invoice, and
        immediately issues it — which mints the next invoice number and posts the journal entry (
        <Code>DR Accounts Receivable / CR Revenue + Tax Payable</Code>) into the ledger. The
        original estimate stays in the system with its <Code>invoiceId</Code> set, so you can always
        trace which quote produced which sale.
      </P>

      <H3 id="estimates-duplicate">Duplicate</H3>
      <P>
        Click <Code>Duplicate</Code> on any estimate (from the row menu or the detail page) to fork
        it into a fresh draft. The customer, currency, line items, notes, and footer are copied
        verbatim; <Code>issueDate</Code> resets to today and <Code>validUntil</Code> to thirty days
        out. The new draft has no number until you issue it, and the original is untouched — handy
        for re-quoting an expired estimate or sending the same package to a different customer (open
        the duplicate, switch the customer in edit mode, and issue).
      </P>

      <H3 id="estimates-printing">Sending and printing</H3>
      <P>
        Every issued estimate has a Print / PDF view at{" "}
        <Code>/api/companies/:cid/estimates/:slug/html</Code>. Use it from the detail page&apos;s{" "}
        <Code>Print / PDF</Code> button —<em>File → Save as PDF</em> in your browser produces a
        clean A4 PDF with no app chrome. The same HTML is what the customer sees when you click{" "}
        <Code>Issue &amp; send</Code> or <Code>Resend email</Code>, and that email now carries a PDF
        copy of the estimate as an attachment — delivered through whichever{" "}
        <DocLink to="/docs/integrations">EmailProvider</DocLink> the company has configured.
      </P>

      <H2 id="customers">Customers</H2>
      <P>
        Customers — the billable accounts you invoice — now live in their own top-level{" "}
        <DocLink to="/docs/customers">Customers</DocLink> section, alongside the people at each
        account and the signed contracts you hold with them. One detail stays relevant here: each
        customer&apos;s <Strong>slug</Strong> (auto-derived from its name, e.g.{" "}
        <Code>Acme Corp</Code> → <Code>acme-corp</Code>) is uppercased and prefixed onto every
        invoice and estimate number issued to that customer, so numbers stay unique and
        self-identify across accounts.
      </P>

      <H2 id="invoices">Invoices</H2>
      <P>
        The invoice flow mirrors estimates with two extras: a <Code>dueDate</Code> and a payments
        ledger. Issuing mints the same slug-prefixed gapless number estimates use — e.g.{" "}
        <Code>ACME-CORP-INV-0001</Code>. Record cash, bank transfers, Stripe charges, or other
        receipts directly on the invoice; each payment posts a matching{" "}
        <Code>DR Bank / CR Accounts Receivable</Code> entry. Once the cumulative paid amount reaches
        the invoice total, the status flips from <Code>sent</Code> to <Code>paid</Code>. Sending or
        resending an invoice emails the customer the rendered document. To copy an internal finance
        mailbox on every delivery, open <Code>Finance → Settings</Code> and add one or more
        addresses under <Strong>Always Cc on invoices</Strong>. The saved addresses are added to
        manual sends, recurring auto-sends, and resends automatically. Before a resend, Genosyn
        shows the exact From and Reply-to addresses in a confirmation modal. Edit the{" "}
        <Code>To</Code> field to add or remove recipients, see the company&apos;s always-Cc
        recipients, add optional additional <Code>Cc</Code> recipients, include a one-off message,
        and choose whether to attach the invoice PDF. Separate multiple addresses with commas. Every
        resend attempt then appears on the invoice&apos;s Activity feed with its delivery status, To
        and Cc recipients, and attachment result.
      </P>
      <P>
        <Code>Duplicate</Code> works the same way as on estimates — from the row menu or the detail
        page, you can fork any invoice (even one that&apos;s already paid or void) into a fresh
        draft. Lines, customer, currency, notes, and footer come along; payments and status
        timestamps do not. The new draft picks up
        <em> today</em> as its issue date and a fourteen-day default due date, and stays unnumbered
        until you issue it.
      </P>

      <H3 id="invoices-void">Voiding an invoice</H3>
      <P>
        <Code>Void</Code> means <em>this invoice should never have been issued</em>. It posts a
        reversing entry that unwinds the original{" "}
        <Code>DR Accounts Receivable / CR Revenue + Tax Payable</Code>, keeping both the original
        and the reversal in the journal so the audit trail stays intact.
      </P>
      <P>
        Two things it deliberately will not do. Voiding an invoice that already has{" "}
        <Strong>payments recorded against it</Strong> is refused — money that genuinely arrived is
        given back with a refund or a credit note, never by rewriting history. And voiding an
        invoice issued inside a <Strong>closed accounting period</Strong> is refused too, because
        the reversal carries today&apos;s date and would pull a closed period&apos;s revenue into
        the current one; reopen the period first. Both rules apply identically to{" "}
        <Code>Void</Code> on a bill.
      </P>

      <H3 id="invoices-write-off">Writing off a balance</H3>
      <P>
        When a receivable won&apos;t be collected, open the invoice and click{" "}
        <Code>Write off</Code>. A write-off clears part or all of the open balance{" "}
        <em>without</em> a payment and <em>without</em> reversing the sale — the revenue stays
        recognized in the period it was earned. Pick <Strong>Bad debt</Strong> for an
        uncollectible debt or <Strong>Residual</Strong> for an immaterial short-payment (a few
        cents of rounding or a settlement discount). It posts{" "}
        <Code>DR Bad Debt Expense / CR Accounts Receivable</Code> and can never exceed the open
        balance. Unlike a credit note it does <em>not</em> relieve tax — a bad debt isn&apos;t a
        sales-tax refund.
      </P>
      <P>
        A fully written-off invoice shows the <Code>Written off</Code> status (it never counts as
        cash collected). Write-offs appear under <Code>Adjustments</Code> on the invoice and as a
        balance adjustment on the customer&apos;s statement. Made a mistake, or the customer paid
        after all? <Code>Reverse</Code> the write-off — it puts the balance back and posts the
        matching reversing entry, which is also how you record a bad-debt recovery.
      </P>

      <H2 id="recurring-invoices">Recurring invoices</H2>
      <P>
        Open <Code>Finance → Recurring</Code> and click <Code>New schedule</Code> to set up a
        template. Pick a customer, choose how often it should bill — every <Strong>N</Strong>{" "}
        <Strong>days</Strong>, <Strong>weeks</Strong>, <Strong>months</Strong>,{" "}
        <Strong>quarters</Strong> or <Strong>years</Strong>, on the day and at the time you set —
        and compose the line items just like a normal invoice. The count lets you say{" "}
        <Code>every 2 weeks</Code> or <Code>every 3 months</Code>, not just every one. A
        plain-English summary (for example <Code>Every 2 weeks on Monday at 9:00 AM</Code>) appears
        beneath the picker so you can confirm the cadence before saving.
      </P>

      <H3 id="recurring-modes">Draft vs auto-send</H3>
      <P>
        Each schedule has an <Strong>Auto-issue and email</Strong> toggle. Off (the default), every
        tick lands as a fresh draft — you review and click <Code>Send</Code> on each one. On, the
        tick issues the invoice (minting its invoice number and posting the AR / Revenue ledger
        entry) and emails it to the customer through the company&apos;s configured EmailProvider —
        same path a human-sent invoice takes, so the email log captures it identically.
      </P>

      <H3 id="recurring-controls">Pausing, ending, running now</H3>
      <P>
        From the detail page, <Code>Run now</Code> generates an invoice immediately without
        consuming the scheduled slot, useful for catch-up runs or testing the template. The{" "}
        <Code>More actions</Code> menu holds the lifecycle controls: <Code>Pause</Code> stops
        scheduled runs without losing the template and <Code>Resume</Code> restarts the next tick
        from now; <Code>End</Code> is terminal — the schedule becomes read-only but every invoice it
        already created stays in your books; <Code>Duplicate</Code> clones the template into a new,
        paused schedule so you can tweak and resume it without touching the original. Optional caps
        — max runs and end date — flip the status to <Code>ended</Code> automatically once hit.
      </P>

      <H2 id="reconciliation">Bank reconciliation</H2>
      <P>
        Open <Code>Finance → Reconciliation</Code> to match external bank lines to the payments and
        journal entries already recorded in Genosyn. CSV upload works with any bank; Stripe payout
        and Brex Cash feeds can pull directly from an encrypted Connection under{" "}
        <DocLink to="/docs/integrations">Settings → Integrations</DocLink>.
      </P>
      <P>
        For Brex, create a <Code>Brex</Code> Connection using a read-only user token, then click{" "}
        <Code>New feed</Code>, choose <Code>Brex Cash</Code>, select the Connection and Cash
        account, and map it to the corresponding asset account in the chart of accounts.{" "}
        <Code>Sync</Code> walks the settled transaction history on the first pull and fetches only
        recent changes after that. Repeated syncs are safe because Genosyn deduplicates rows by Brex
        transaction id.
      </P>

      <H2 id="card-expenses">Corporate card expenses</H2>
      <P>
        Open <Code>Finance → Card expenses</Code> to connect the primary Brex corporate card
        account. Choose the <Code>2300 Corporate Card Payable</Code> liability, a default expense
        category, and the bank asset used to pay the statement. The Brex user token needs{" "}
        <Code>transactions.card.readonly</Code>.
      </P>
      <P>
        Sync imports the complete settled card history and posts balanced entries automatically:
        purchases debit the expense category and credit the card liability; refunds reverse those
        legs; statement payments debit the liability and credit the selected bank account. Changing
        a purchase category writes a separate reclassification entry, preserving the audit trail.
        Failed postings remain visible with a retry action.
      </P>

      <H2 id="ledger">Ledger and reports</H2>
      <P>
        Every state change on an invoice or bill emits a journal entry into the same ledger you can
        write to by hand from <Code>Finance → Journal</Code>. The chart of accounts seeds sensible
        defaults on first visit (1100 Bank, 1200 Accounts Receivable, 2100 Tax Payable, 2300
        Corporate Card Payable, 4000 Sales Revenue, 4910 FX Gain, 6900 FX Loss), but you can rename,
        reparent, or add accounts freely as long as you don&apos;t touch the system codes the
        auto-posting depends on. From there, the <Code>Trial balance</Code> and <Code>Reports</Code>{" "}
        pages produce the standard accountant outputs (P&amp;L, balance sheet, cash flow) with
        optional period comparisons. Each report opens with a monthly graph built from the same
        ledger calculation as the table beneath it: revenue, expenses, and net income for P&amp;L;
        assets, liabilities, and equity for the balance sheet; and operating, net, and closing cash
        for cash flow. Custom periods longer than two years graph the most recent 24 months so the
        axis stays readable.
      </P>

      <H2 id="transaction-review">Review and approve transactions</H2>
      <P>
        Open <Code>Finance → Transactions</Code>. Every posted journal entry — whether it came from
        an invoice, bill, card purchase, or a manual posting — starts under{" "}
        <Strong>Needs review</Strong>. Open a row to inspect its complete debits and credits.
        Expense and revenue lines have an account-category picker; control accounts such as Bank,
        Accounts Receivable, and Card Payable stay visible but cannot be casually recategorized.
        Owners and admins click <Code>Approve transaction</Code>
        for final sign-off.
      </P>
      <P>
        Category corrections are append-only. Approval writes a balanced reclassification entry and
        preserves the original posting, so the Journal and audit log show both sides of the
        decision. Nothing edits a posted ledger line in place.
      </P>
      <P>
        When several transactions call for the same decision, tick the checkbox on each row (or the
        header checkbox to take the whole list) and a selection bar appears with bulk{" "}
        <Code>Approve</Code>, <Code>Return</Code>, <Code>Change category</Code>, and{" "}
        <Code>Delete</Code>. <Strong>Change category</Strong> moves each transaction&apos;s single
        expense or revenue line to one category and approves it in the same step. Bulk delete only
        removes unapproved manual drafts. Every action runs per-transaction: rows that don&apos;t
        qualify — already approved, auto-posted, or the wrong shape for a shared category — are
        skipped and reported back, never silently changed. Approve, Return, and Change category stay
        limited to owners and admins.
      </P>

      <H2 id="ai-access">Give AI employees finance access</H2>
      <P>
        By default an AI employee cannot touch Finance at all. Open <Code>Finance → AI access</Code>{" "}
        (owners and admins only) to grant an employee access at one of three escalating levels:
      </P>
      <UL>
        <LI>
          <Strong>Read only</Strong> — list and open invoices and customers, and read the P&amp;L,
          balance sheet, cash flow, trial balance, chart of accounts, and posted transactions.
          Changes nothing.
        </LI>
        <LI>
          <Strong>Invoicing</Strong> — everything in Read, plus the full accounts-receivable loop:
          create, issue, email, and void invoices; create and update customers; and record payments
          to mark an invoice paid. Issuing an invoice mints its number and posts it to the ledger;
          sending emails it to the customer on file.
        </LI>
        <LI>
          <Strong>Full accounting</Strong> — everything in Invoicing, plus staging ledger
          re-categorizations for a human to approve (below). Final approval always stays with a
          human.
        </LI>
      </UL>
      <P>
        Access is per employee and takes effect immediately — grant it, change the level, or revoke
        it from <Code>Finance → AI access</Code>. Every write an AI employee makes lands in the
        audit log (marked as an AI actor) and on the employee&apos;s journal, exactly like the human
        finance routes. Members still reach Finance through the app as usual; grants govern the AI
        surface only.
      </P>

      <H3 id="ai-finance-tools">The finance tool family</H3>
      <P>
        Granted employees get a built-in <Code>finance</Code> tool. Its read ops (
        <Code>list_invoices</Code>, <Code>get_invoice</Code>, <Code>list_customers</Code>,{" "}
        <Code>get_customer</Code>, plus the accounts / transactions / report ops) need{" "}
        <Strong>Read</Strong>. The invoice lifecycle — <Code>create_invoice</Code>,{" "}
        <Code>send_invoice</Code>, <Code>record_payment</Code>, <Code>void_invoice</Code>,{" "}
        <Code>create_customer</Code>, and <Code>update_customer</Code> — needs{" "}
        <Strong>Invoicing</Strong>. Amounts are integer minor units (cents), so <Code>5000</Code> is
        $50.00. An employee with no grant gets no finance tool at all.
      </P>
      <P>
        When an AI employee sends an invoice, any <Code>To</Code> / <Code>Cc</Code> it supplies is
        restricted to the customer&apos;s own email domain or a finance mailbox you saved under{" "}
        <Code>Finance → Settings → Always Cc</Code> — an AI can&apos;t mail company documents to an
        arbitrary outside address, even if a malicious invoice memo or bank description tries to talk
        it into doing so. A person sending from the invoice page is unaffected and can still address
        anyone.
      </P>

      <H3 id="ai-invoice-email">Emailing an invoice PDF</H3>
      <P>
        An employee that also has an <DocLink to="/docs/email">Email</DocLink> grant can attach an
        invoice&apos;s PDF straight to a message — no need to dig the file out of a past email. The{" "}
        <Code>create_mail_draft</Code> and <Code>send_mail</Code> tools (and the Gmail integration&apos;s{" "}
        <Code>gmail_create_draft</Code> / <Code>gmail_send_message</Code>) take an{" "}
        <Code>attachments</Code> list; name an invoice by <Code>invoiceSlug</Code> and Genosyn renders
        the PDF on the fly and attaches it. So a routine can reply on the original billing thread —
        preserving the recipient and CCs — with the invoice attached. Rendering the PDF needs at
        least <Strong>Read</Strong> finance access; sending needs the matching mailbox grant.
      </P>

      <H3 id="ai-transaction-review">AI transaction review</H3>
      <P>
        At the <Strong>Full accounting</Strong> level an employee can also inspect posted
        transactions and semi-approve one with a concise review note and optional category
        proposals. The proposal does not change the ledger. It moves the transaction to{" "}
        <Strong>AI reviewed</Strong> and notifies company owners/admins, who accept the proposal,
        change it, or return the transaction for another look. AI employees cannot issue final
        approval.
      </P>
    </>
  );
}
