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
          <Strong>Subsidiaries</Strong> — legal entities you can select as the issuer of invoices,
          estimates, and recurring invoices, with their own address, tax details, and footer.
        </LI>
        <LI>
          <Strong>Customer statements</Strong> — per-customer account activity, balances, and aging,
          with print and PDF output.
        </LI>
        <LI>
          <Strong>Recurring invoices</Strong> — invoice templates that fire on a repeating schedule
          (monthly retainers, annual licences). Each run materializes a fresh invoice into the
          regular invoice list, and the schedule lists every invoice it has created.
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
          Click a product&apos;s, tax rate&apos;s, vendor&apos;s, or account&apos;s name to open it.
        </LI>
        <LI>
          <Strong>Banking</Strong> — your bank accounts and cards with every transaction on them:
          mark the invoices a deposit paid, match what is already in the books, or give a
          transaction a category. See <DocLink to="/docs/banking">Banking</DocLink>.
        </LI>
        <LI>
          <Strong>Accounting</Strong> — P&amp;L / balance sheet / cash flow reports, the chart of
          accounts, journal entries, entry review, trial balance, and accounting periods.
        </LI>
      </UL>
      <P>
        The Finance sidebar follows the same split: <Code>Overview</Code> and{" "}
        <Code>Banking</Code> at the top, then <Code>Sales</Code>, <Code>Purchases</Code>,{" "}
        <Code>Accounting</Code>, and <Code>Catalog</Code>.
      </P>

      <H2 id="subsidiaries">Invoice from different legal entities</H2>
      <P>
        Open <Code>Finance → Subsidiaries → Add subsidiary</Code>. An owner or admin enters the
        entity&apos;s <Code>Legal name</Code>, <Code>Registered address</Code>, country, tax / VAT
        and registration numbers, and contact details. The optional <Code>Default footer</Code>
        holds that entity&apos;s payment terms or bank details.
      </P>
      <P>
        On a new invoice, estimate, or recurring invoice, choose the entity under{" "}
        <Code>Issued by</Code>. <Code>Company default</Code> keeps the usual company issuer. You can
        change this choice while editing a draft or recurring schedule. A document&apos;s own footer
        takes precedence; leave it blank to use the selected subsidiary&apos;s footer. Currency
        remains a separate choice, initially taken from the customer.
      </P>
      <P>
        Each invoice and estimate saves a copy of its issuer details. Editing a subsidiary later
        does not rewrite those documents, their PDFs, or an estimate converted to an invoice.
        Recurring invoices use the subsidiary&apos;s current details when each new invoice is
        created. <Code>Archive</Code> removes an entity from new selections;{" "}
        <Code>Show archived</Code> and <Code>Reactivate</Code> bring it back without deleting its
        history. A recurring schedule cannot create another invoice using an archived subsidiary;
        choose an active issuer or reactivate it to continue billing.
      </P>
      <P>
        Subsidiaries identify the legal issuer on documents. Numbering, the ledger, reports, and
        email delivery settings stay shared across the company; adding one does not create separate
        accounting books. Invoice CSV exports include <Code>Subsidiary ID</Code> and{" "}
        <Code>Issued by</Code> columns, with the saved issuer name.
      </P>
      <P>
        An AI Employee with Finance access can discover issuing entities through{" "}
        <Code>list_subsidiaries</Code>. With <Strong>Invoicing</Strong> access, it can provide the
        chosen <Code>subsidiaryId</Code> when creating an invoice, estimate, or recurring schedule.
        Only an owner or admin can create or edit the subsidiaries themselves.
      </P>

      <H2 id="estimates">Estimates (quotations)</H2>
      <P>
        Estimates are pre-sale documents — proposed line items with prices, sent to a customer for
        sign-off. They do not affect the general ledger; only the invoice that an estimate converts
        into does. When the selected customer has a billing address, it appears in the estimate
        detail and customer-facing PDF.
      </P>

      <H3 id="estimates-lifecycle">Lifecycle</H3>
      <OL>
        <LI>
          <Strong>Draft</Strong> — fully editable. Click <Code>New estimate</Code>, pick a customer,
          add line items, save. <Code>Add line</Code> on any invoice, estimate, recurring invoice,
          or bill puts the cursor in the new line&apos;s description. The slug looks like{" "}
          <Code>edraft-xxxxxx</Code> until issue.
        </LI>
        <LI>
          <Strong>Sent</Strong> — clicking <Code>Issue</Code> (or <Code>Issue &amp; send</Code> to
          email the customer) mints a gapless number prefixed with the customer&apos;s slug — e.g.{" "}
          <Code>ACME-CORP-EST-0001</Code> — so two customers&apos; first estimates never both read{" "}
          <Code>EST-0001</Code>. The URL slug becomes the lowercased number. A sent estimate can
          still be revised and resent under the same number — see{" "}
          <DocLink to="/docs/finance#estimates-edit">Editing a sent estimate</DocLink>.
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
          passed and the estimate is still in <Code>sent</Code>. Extend <Code>Valid until</Code>{" "}
          from <Code>Edit</Code>, or void it.
        </LI>
        <LI>
          <Strong>Void</Strong> — terminal cancellation, available on any non-draft estimate.
        </LI>
      </OL>

      <H3 id="estimates-discount">Discounts</H3>
      <P>
        Estimates take a discount just like invoices — a percentage or a fixed amount off the whole
        quote, before tax. Converting the estimate copies the discount onto the invoice, so the
        customer is billed what they were quoted. See{" "}
        <DocLink to="/docs/finance#invoices-discount">Discounts</DocLink> under Invoices.
      </P>

      <H3 id="estimates-edit">Editing a sent estimate</H3>
      <P>
        A quote that has gone out can still change. On a sent or accepted estimate, click{" "}
        <Code>Edit</Code>: the lines, discount, dates, currency, notes and footer are all editable,
        and the estimate keeps its number. Its customer and issuer are fixed once it is issued,
        because the number belongs to that customer — duplicate it to quote someone else. Saving
        never emails the customer: <Code>Save changes</Code> only saves, while{" "}
        <Code>Save &amp; resend</Code> saves and emails the updated estimate to the customer
        straight away, like <Code>Resend email</Code>.
      </P>
      <P>
        The customer accepted the version they saw, so any change to an <Strong>accepted</Strong>{" "}
        estimate moves it back to <Strong>Sent</Strong> — mark it accepted again once they accept
        the new one. Declined, void and converted estimates can&apos;t be edited: duplicate one to
        quote again, or edit the invoice it became. Lines you leave alone stay exactly as they were,
        and changed lines keep the tax rate the estimate was issued with even if that rate has since
        changed. If the estimate changed after it was last emailed, its page says so with a{" "}
        <Code>Resend</Code> button, and its{" "}
        <DocLink to="/docs/security#record-history">History</DocLink> records the edit, what
        changed, and the old and new totals.
      </P>

      <H3 id="estimates-convert">Convert to an invoice</H3>
      <P>
        From an accepted (or still-sent) estimate, click <Code>Convert to invoice</Code>. Genosyn
        copies every line verbatim, inherits the customer and currency, creates a draft invoice, and
        immediately issues it — which mints the next invoice number and posts the journal entry (
        <Code>DR Accounts Receivable / CR Revenue + Tax Payable</Code>) into the ledger. The
        original estimate stays in the system with its <Code>invoiceId</Code> set, so you can always
        trace which quote produced which sale. For work billed again and again, such as a monthly
        retainer, click <Code>Make recurring</Code> instead to start a recurring invoice from the
        estimate — see{" "}
        <DocLink to="/docs/finance#recurring-from-document">From an invoice or estimate</DocLink>.
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

      <H3 id="estimates-archive">Archive</H3>
      <P>
        Archive the estimates you no longer need in front of you — expired quotes, declined ones,
        drafts you may come back to — without deleting or voiding anything. In{" "}
        <Code>Finance → Estimates</Code>, tick the checkbox beside each one (shift-click ticks a
        range, and the header checkbox ticks every estimate in the current tab), then click{" "}
        <Code>Archive</Code> in the bar that appears. One estimate can also be archived from its row
        menu or from the <Code>More actions</Code> menu on its detail page. There is no
        confirmation, because nothing is lost: archiving only files an estimate away.
      </P>
      <P>
        An archived estimate keeps its number, status, PDF, and any converted invoice. It still
        opens from its link, and every action on it works as before. It leaves the status tabs and
        the customer&apos;s page for the <Code>Archived</Code> tab, where you can select estimates
        and click <Code>Restore</Code> to bring them back — or use <Code>Restore</Code> on the
        estimate itself. AI Employees see the same split: <Code>list_estimates</Code> leaves
        archived estimates out unless asked to include them, and an archived estimate is never
        suggested to them as an accepted quote still waiting to be converted.
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
      <P>
        <Code>Issue &amp; send</Code> checks that there is somewhere to send before it issues
        anything. If the customer has no email address on file, the estimate stays a draft with its
        <Code>edraft-xxxxxx</Code> slug and no number is minted — add the address and click again.
        The same holds for invoices, where issuing also posts to the ledger: a send that cannot go
        out leaves the draft, its number, and the books untouched. A delivery that fails later — the
        SMTP host is down, say — is reported on the detail page, and the document is still issued.
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
      <P>
        Picking a customer on an invoice, estimate, or recurring invoice shows the billing email the
        document is sent to and the billing address it prints, with a small warning for whichever is
        missing — see{" "}
        <DocLink to="/docs/customers#bill-to">Email and address on documents</DocLink>.
      </P>

      <H2 id="customer-statements">Customer statements</H2>
      <P>
        Open <Code>Finance → Customer statements</Code> and choose a customer to view their
        statement of account. The chooser is searchable and includes archived customers, so past
        account history stays available. You can switch the period, select a currency when the
        customer has been billed in more than one, open the print view, or download a PDF. Invoice
        numbers link back to their full documents in Finance.
      </P>
      <P>
        This is the same statement available from a customer&apos;s overview in the Customers
        section. See <DocLink to="/docs/customers#statements">Customer statements</DocLink> for how
        periods, currencies, and aging work.
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
        resend attempt then appears in the invoice&apos;s{" "}
        <DocLink to="/docs/security#record-history">History</DocLink> with who sent it, its delivery
        status, To and Cc recipients, and attachment result.
      </P>
      <P>
        <Code>Duplicate</Code> works the same way as on estimates — from the row menu or the detail
        page, you can fork any invoice (even one that&apos;s already paid or void) into a fresh
        draft. Lines, customer, currency, notes, and footer come along; payments and status
        timestamps do not. The new draft picks up
        <em> today</em> as its issue date and a fourteen-day default due date, and stays unnumbered
        until you issue it. To bill the same invoice on a schedule instead, use{" "}
        <Code>Make recurring</Code> — see{" "}
        <DocLink to="/docs/finance#recurring-from-document">From an invoice or estimate</DocLink>.
      </P>
      <P>
        <Code>Finance → Invoices</Code> opens on <Strong>Active</Strong>: every invoice that
        isn&apos;t void, from drafts to paid. Voided invoices stay in your records under the{" "}
        <Code>Void</Code> tab, invoices you{" "}
        <DocLink to="/docs/finance#invoices-archive">archive</DocLink> wait under{" "}
        <Code>Archived</Code>, and the other tabs narrow Active down by status.
      </P>

      <H3 id="invoices-paid-confirmation">Paid confirmation</H3>
      <P>
        When an invoice becomes <Code>paid</Code>, Genosyn emails each of the company&apos;s owners
        and admins a confirmation: the invoice number, customer and total, the payments that settled
        it, and a link to the invoice. The customer is not emailed. It goes out once, at the moment
        the invoice turns Paid, whoever got it there — a Member recording a payment, an AI Employee
        using <Code>record_payment</Code>, or a credit note covering what payments left — and again
        only if the invoice reopens and is paid a second time. An invoice settled only by a write-off
        or a credit shows as <Code>Written off</Code> or <Code>Credited</Code> and sends nothing,
        because nobody paid it. The confirmation goes through the company&apos;s email transport, and
        each copy appears under <Code>Settings → Email Logs</Code>.
      </P>

      <H3 id="invoices-discount">Discounts</H3>
      <P>
        To give a customer a discount on a whole invoice or estimate, click{" "}
        <Code>Add discount</Code> under the totals on its edit page and type a percentage or a fixed
        amount — the toggle beside the box switches between <Code>%</Code> and the document&apos;s
        currency. The totals update as you type. The discount comes off the subtotal{" "}
        <Strong>before tax</Strong>, so tax is charged on the discounted price; with several lines
        it is shared across them in proportion to their amounts, and each keeps its own tax rate.
        The detail page, the PDF and the email show the subtotal, the discount and the total, and
        the lines still read quantity × unit price.
      </P>
      <P>
        A discount stays with the document. <Code>Duplicate</Code> keeps it, converting an estimate
        carries it onto the invoice, <Code>Make recurring</Code> carries it onto every invoice the
        schedule creates, and a full credit note credits what was charged — the lines less a
        matching <Code>Discount</Code> line. In the books an invoice&apos;s revenue is its
        discounted subtotal; no separate discount account is involved. A discount can be added to a
        sent invoice or estimate like any other edit, so the same limits apply: it can&apos;t take
        an invoice below what is already paid, and it posts an <Strong>Invoice revised</Strong>{" "}
        entry. AI Employees can include one with <Code>discountPercent</Code> or{" "}
        <Code>discountAmountCents</Code> on <Code>create_estimate</Code>,{" "}
        <Code>create_invoice</Code>, <Code>create_recurring_invoice</Code> and{" "}
        <Code>update_recurring_invoice</Code>.
      </P>

      <H3 id="invoices-edit">Editing and resending an invoice</H3>
      <P>
        A sent or paid invoice can be corrected and resent under the same number. Click{" "}
        <Code>Edit</Code> on the invoice: the lines, discount, dates, notes and footer are editable,
        and so is the currency until money is applied. Then choose <Code>Save changes</Code>, or{" "}
        <Code>Save &amp; resend</Code> to open the resend dialog with a note telling the customer
        this copy replaces the earlier one — you still confirm the recipients and the message before
        anything goes out. If you save without resending, the invoice&apos;s page says it changed
        since it was last emailed, with a <Code>Resend</Code> button.
      </P>
      <P>
        The books follow the edit. A change to the amounts — lines or discount — currency or issue
        date posts an <Strong>Invoice revised</Strong> journal entry that brings Accounts
        Receivable, revenue and tax payable to what the invoice now says; the original issue entry
        stays in the journal. Moving the issue date moves the revenue to the new date&apos;s period,
        and voiding a revised invoice reverses the revisions along with the original. What keeps an
        edit safe:
      </P>
      <UL>
        <LI>
          The customer and issuer are fixed — the number belongs to that customer, from that legal
          entity. To bill someone else, void the invoice and duplicate it.
        </LI>
        <LI>
          The total must stay positive and can&apos;t drop below what is already paid, credited or
          written off. Raising the total of a paid invoice reopens it with the difference due.
        </LI>
        <LI>
          Once money is applied, the currency is fixed, and so is the issue date of a
          foreign-currency invoice, since its payments were booked at that date&apos;s exchange
          rate.
        </LI>
        <LI>
          An invoice issued in a <Strong>closed accounting period</Strong> can&apos;t change its
          amounts or dates until the period is reopened; its notes, footer and due date stay
          editable.
        </LI>
        <LI>
          Lines you leave alone stay exactly as they were, and changed lines keep the tax rate the
          invoice was issued with.
        </LI>
      </UL>
      <P>
        Every edit appears in the invoice&apos;s{" "}
        <DocLink to="/docs/security#record-history">History</DocLink> as an edit made after it was
        sent, with the fields that changed and the old and new totals.
      </P>

      <H3 id="invoices-payments">One payment, one invoice</H3>
      <P>
        A payment&apos;s <Code>Reference</Code> — the bank transfer id, Stripe charge id or cheque
        number — names one real payment, and Genosyn records it only once. Recording a payment whose
        reference is already on an invoice is refused with the invoice it is on, whether that is
        another invoice or the same one, so the same money can&apos;t settle two invoices. The match
        ignores capitals and surrounding spaces. If a payment went on the wrong invoice, delete it
        there and record it on the right one. Payments recorded without a reference can&apos;t be
        told apart, so they are never treated as the same payment. AI Employees recording payments
        with <Code>record_payment</Code> are held to the same rule.
      </P>

      <H3 id="invoices-void">Voiding an invoice</H3>
      <P>
        <Code>Void</Code> means <em>this invoice should never have been issued</em>. It posts a
        reversing entry that unwinds the original{" "}
        <Code>DR Accounts Receivable / CR Revenue + Tax Payable</Code>, keeping both the original
        and the reversal in the journal so the audit trail stays intact. A voided invoice leaves the
        default <Strong>Active</Strong> list and the Finance overview&apos;s{" "}
        <Strong>Recent invoices</Strong>; find it under the <Code>Void</Code> tab.
      </P>
      <P>
        Two things it deliberately will not do. Voiding an invoice that already has{" "}
        <Strong>payments recorded against it</Strong> is refused — money that genuinely arrived is
        given back with a refund or a credit note, never by rewriting history. And voiding an
        invoice issued inside a <Strong>closed accounting period</Strong> is refused too, because
        the reversal carries today&apos;s date and would pull a closed period&apos;s revenue into
        the current one; reopen the period first. Both rules apply identically to <Code>Void</Code>{" "}
        on a bill.
      </P>

      <H3 id="invoices-archive">Archive</H3>
      <P>
        Archive the invoices you no longer need in front of you — paid ones, voided ones, drafts you
        may come back to — without deleting or changing anything. In{" "}
        <Code>Finance → Invoices</Code>, tick the checkbox beside each one (shift-click ticks a
        range, and the header checkbox ticks every invoice in the current tab that can be archived),
        then click <Code>Archive</Code> in the bar that appears. One invoice can also be archived
        from its row menu or from the <Code>More actions</Code> menu on its detail page. There is
        no confirmation, because nothing is lost: archiving only files an invoice away.
      </P>
      <P>
        Only an invoice with nothing left to collect can be archived: a draft, a void invoice, or
        an issued one that is paid, credited, or{" "}
        <DocLink to="/docs/finance#invoices-write-off">written off</DocLink>. An invoice with a
        balance due keeps its checkbox disabled and has no <Code>Archive</Code> in its menus, so
        money still owed to you is never out of sight. If an archived invoice is owed money again —
        you issue an archived draft, delete a payment, reverse a write-off, or unapply a credit — it
        comes back to the lists by itself.
      </P>
      <P>
        An archived invoice keeps its number, status, payments, PDF, and ledger entries, and it
        still counts in every total: outstanding and paid on the Finance overview, the
        customer&apos;s outstanding and lifetime billed, statements, and reports. It still opens
        from its link, and every action on it works as before. It leaves the status tabs and the
        customer&apos;s page for the <Code>Archived</Code> tab, where you can select invoices and
        click <Code>Restore</Code> to bring them back — or use <Code>Restore</Code> on the invoice
        itself. AI Employees see the same split: <Code>list_invoices</Code> leaves archived
        invoices out unless asked to include them.
      </P>

      <H3 id="invoices-write-off">Writing off a balance</H3>
      <P>
        When a receivable won&apos;t be collected, open the invoice and click <Code>Write off</Code>
        . A write-off clears part or all of the open balance <em>without</em> a payment and{" "}
        <em>without</em> reversing the sale — the revenue stays recognized in the period it was
        earned. Pick <Strong>Bad debt</Strong> for an uncollectible debt or{" "}
        <Strong>Residual</Strong> for an immaterial short-payment (a few cents of rounding or a
        settlement discount). It posts <Code>DR Bad Debt Expense / CR Accounts Receivable</Code> and
        can never exceed the open balance. Unlike a credit note it does <em>not</em> relieve tax — a
        bad debt isn&apos;t a sales-tax refund.
      </P>
      <P>
        A fully written-off invoice shows the <Code>Written off</Code> status (it never counts as
        cash collected). Write-offs appear under <Code>Adjustments</Code> on the invoice and as a
        balance adjustment on the customer&apos;s statement. Made a mistake, or the customer paid
        after all? <Code>Reverse</Code> the write-off — it puts the balance back and posts the
        matching reversing entry, which is also how you record a bad-debt recovery.
      </P>

      <H3 id="invoices-credit-note">Credit notes</H3>
      <P>
        A credit note reduces a sale you&apos;ve already invoiced — a return, a goodwill adjustment,
        a billing correction. From an invoice, click <Code>Credit note</Code>: credit it{" "}
        <Strong>in full</Strong> (every line, tax included) or a <Strong>partial</Strong> ex-tax
        amount. Issuing posts{" "}
        <Code>DR Sales Returns &amp; Allowances / DR Tax Payable / CR Customer Credits</Code> — it
        reverses revenue (and tax, on a full credit) but never touches Accounts Receivable directly,
        and credit notes can never total more than the invoice they came from.
      </P>
      <P>
        A credit is spent by <Strong>applying</Strong> it to an invoice, which is the only way to
        lower a receivable without cash: it posts{" "}
        <Code>DR Customer Credits / CR Accounts Receivable</Code>, capped so the invoice balance can
        never go negative. Raising a credit against an invoice applies it there by default; an
        on-account credit can be applied to any of that customer&apos;s invoices in the same
        currency from the <Code>Credit notes</Code> section. An invoice fully cleared by credit
        shows the <Code>Credited</Code> status. Unapply to put the balance back, and void an unused
        credit memo to reverse it entirely.
      </P>

      <H3 id="refunds-deposits">Refunds, deposits and overpayments</H3>
      <P>
        A credit can be paid back in cash instead of applied: from a credit note, click{" "}
        <Code>Refund</Code>. It posts <Code>DR Customer Credits / CR Bank</Code> against the
        credit&apos;s open balance, and can be reversed if the money comes back. A{" "}
        <Strong>deposit</Strong> takes money before any invoice exists —{" "}
        <Code>DR Bank / CR Customer Deposits</Code>, held as unearned revenue (no sales tax on
        receipt) until you apply it to the eventual invoice.
      </P>
      <P>
        When a customer pays more than an invoice&apos;s balance, tick{" "}
        <Strong>Record the excess as an on-account customer credit</Strong> in the payment dialog:
        the balance-due portion posts as a normal payment and the overage becomes a credit (
        <Code>DR Bank / CR Customer Credits</Code>) you can apply to their next invoice or refund.
        Until you tick it, <Code>Record payment</Code> stays disabled for any amount above the
        balance due. On an invoice that&apos;s already paid, <Code>Record payment</Code> is in the{" "}
        <Code>More actions</Code> menu and the whole amount becomes a credit.
      </P>

      <H2 id="recurring-invoices">Recurring invoices</H2>
      <P>
        Open <Code>Finance → Recurring</Code> and click <Code>New schedule</Code> to set up a
        template, or click <Code>New recurring invoice</Code> on a customer&apos;s{" "}
        <DocLink to="/docs/customers#overview">Billing tab</DocLink> to start one with that customer
        already picked. Pick a customer, choose how often it should bill — every <Strong>N</Strong>{" "}
        <Strong>days</Strong>, <Strong>weeks</Strong>, <Strong>months</Strong>,{" "}
        <Strong>quarters</Strong> or <Strong>years</Strong>, on the day and at the time you set —
        and compose the line items just like a normal invoice. <Code>Add discount</Code> under
        the totals takes a percentage or a fixed amount off every invoice the schedule creates,
        before tax, exactly as on an{" "}
        <DocLink to="/docs/finance#invoices-discount">invoice</DocLink>. The count lets you say{" "}
        <Code>every 2 weeks</Code> or <Code>every 3 months</Code>, not just every one. A
        plain-English summary (for example <Code>Every 2 weeks on Monday at 9:00 AM</Code>) appears
        beneath the picker so you can confirm the cadence before saving.
      </P>
      <P>
        The list shows what each schedule bills per run, discount taken and tax included, with its
        currency, and
        whether each run creates a draft or issues and emails the invoice. The same schedules appear
        on the customer&apos;s <DocLink to="/docs/customers#overview">overview</DocLink>.
      </P>

      <H3 id="recurring-invoices-created">The invoices a schedule created</H3>
      <P>
        Open a schedule to see every invoice it has created, from its scheduled runs and from{" "}
        <Code>Run now</Code>, newest first. Each row shows the invoice number (or{" "}
        <Code>DRAFT</Code>), its status, issue and due dates, total, and balance; click a row to
        open the invoice. Drafts, paid, void, and{" "}
        <DocLink to="/docs/finance#invoices-archive">archived</DocLink> invoices are all listed,
        since this is the schedule&apos;s history rather than a worklist. The latest 10 show first,
        and <Code>Show all</Code> lists the rest.
      </P>
      <P>
        The <Strong>Invoices so far</Strong> card beside the schedule sums them up: how many it
        created and how many are still drafts, what was invoiced (issued invoices, void ones left
        out), what has been paid, what is still outstanding and how many invoices are overdue,
        and a link to the latest invoice. A schedule whose currency was changed shows a total for
        each currency rather than adding them together.
      </P>
      <P>
        Each invoice links back as well. Under its number, an invoice a schedule created reads{" "}
        <Code>Created by the recurring invoice</Code> followed by the schedule&apos;s name, which
        opens it. In <Code>Finance → Invoices</Code> and on a customer&apos;s{" "}
        <DocLink to="/docs/customers#overview">Billing tab</DocLink>, a small repeat mark beside
        the number shows which invoices came from a schedule; in Invoices it opens that schedule.
        Deleting a schedule keeps the invoices it created as ordinary invoices, no longer linked to
        it; their History still records which schedule created them.
      </P>
      <P>
        Invoices a schedule created before invoices recorded their schedule are linked wherever
        Genosyn&apos;s records show which schedule created them: the schedule&apos;s run log, the
        invoice&apos;s History, and the schedule&apos;s pointer to its latest invoice. One those
        records don&apos;t cover stays unlinked rather than being guessed at, so the run count can
        be higher than the list; the page then says how many invoices aren&apos;t listed and links
        to the customer&apos;s Billing tab, which shows them all. Through the API, every invoice
        carries{" "}
        <Code>recurringInvoiceId</Code>, and{" "}
        <Code>GET /api/companies/:cid/invoices?recurringInvoiceId=…&amp;archived=true</Code> lists
        one schedule&apos;s invoices.
      </P>

      <H3 id="recurring-from-document">From an invoice or estimate</H3>
      <P>
        To bill an existing invoice or estimate on a schedule, click <Code>Make recurring</Code> in
        its row menu or in the <Code>More actions</Code> menu on its page. The New recurring invoice
        form opens filled in from it: the customer, issuer, currency, line items, discount, notes
        and footer, and, from an invoice, its payment terms as <Strong>Days until due</Strong>.
        Choose how often to bill and click <Code>Create schedule</Code>. The invoice or estimate
        itself doesn&apos;t change, and nothing is billed until the schedule&apos;s first run.
      </P>
      <P>
        A line whose tax rate has since been deleted starts untaxed, and the form says so. If the
        document&apos;s customer has been archived, the form asks you to choose one rather than
        billing someone else.
      </P>

      <H3 id="recurring-names">Naming a schedule</H3>
      <P>
        A new schedule&apos;s <Strong>Name</Strong> starts as its customer&apos;s name. Until you
        type a name of your own, picking another customer renames it to match; once you have typed
        one, changing the customer leaves it alone. Clear the field to hand the name back to the
        customer: a schedule saved with an empty name takes the customer&apos;s name, and the next
        customer you pick fills the field in again. Editing a schedule never renames it, even when
        you move it to another customer. If the customer you started from is archived, the form
        picks no customer and asks you to choose one rather than billing someone else.
      </P>
      <P>
        The API and AI Employees follow the same rule. <Code>name</Code> is optional when creating a
        schedule with <Code>POST /api/companies/:cid/recurring-invoices</Code> or the{" "}
        <Code>create_recurring_invoice</Code> tool: left out or blank, it becomes the
        customer&apos;s name. An edit that sends a name must send one that isn&apos;t blank.
      </P>

      <H3 id="recurring-modes">Draft vs auto-send</H3>
      <P>
        Each schedule has an <Strong>Auto-issue and email</Strong> toggle. Off (the default), every
        tick lands as a fresh draft — you review and click <Code>Send</Code> on each one. On, the
        tick issues the invoice (minting its invoice number and posting the AR / Revenue ledger
        entry) and emails it to the customer through the company&apos;s configured EmailProvider —
        same path a human-sent invoice takes, so the email log captures it identically.
      </P>

      <H3 id="recurring-reliability">Failed runs and downtime</H3>
      <P>
        Each scheduled run is recorded before any work starts, so a crash, restart, or outage cannot
        lose it. When the server comes back, it bills what came due while it was down (several
        missed slots collapse into one invoice) and finishes any run it was in the middle of. It
        continues that run&apos;s invoice rather than creating a second one, so a customer is never
        billed twice for the same slot.
      </P>
      <P>
        If creating, issuing, or emailing the invoice fails, Genosyn retries it automatically after
        1, 5, and 15 minutes, then 1, 3, and 6 hours, and every 6 hours after that until it
        succeeds. Email stops after six failed attempts, or at once when no email transport is
        configured; the invoice stays issued and you send it from its page. Meanwhile the list marks
        the schedule <Strong>Retrying</Strong> or <Strong>Email not sent</Strong>, and the detail
        page shows the error and the time of the next attempt. A schedule starts its next run only
        after the current one finishes. Pausing or ending the schedule stops a run that hasn&apos;t
        finished.
      </P>

      <H3 id="recurring-ai-employees">Using an AI Employee</H3>
      <P>
        An AI Employee with <Strong>Invoicing</Strong> Finance access can list and inspect recurring
        invoices, create a schedule, and update its cadence, customer, line items, discount,
        limits, or status. The four tools are <Code>list_recurring_invoices</Code>,{" "}
        <Code>get_recurring_invoice</Code>, <Code>create_recurring_invoice</Code>, and{" "}
        <Code>update_recurring_invoice</Code>. AI-created schedules are draft-only by default: each
        tick creates an invoice for a Member to review. The employee must set <Code>autoSend</Code>
        explicitly to issue and email every future invoice automatically. A schedule the employee
        doesn&apos;t name is named after its customer, as in the form. To see what a schedule has
        billed, the employee passes its slug to <Code>list_invoices</Code> as{" "}
        <Code>recurringInvoiceSlug</Code>; every invoice that tool returns names the schedule that
        created it, if any.
      </P>

      <H3 id="recurring-controls">Pausing, ending, running now</H3>
      <P>
        From the detail page, <Code>Run now</Code> generates an invoice immediately without
        consuming the scheduled slot, useful for catch-up runs or testing the template. While a
        scheduled run is retrying, the button reads <Code>Retry now</Code> and finishes that run
        instead of creating an extra invoice. The <Code>More actions</Code> menu holds the lifecycle
        controls: <Code>Pause</Code> stops scheduled runs without losing the template and{" "}
        <Code>Resume</Code> restarts the next tick from now; <Code>End</Code> is terminal — the
        schedule becomes read-only but every invoice it already created stays in your books;{" "}
        <Code>Duplicate</Code> clones the template into a new, paused schedule so you can tweak and
        resume it without touching the original. Optional caps — max runs and end date — flip the
        status to <Code>ended</Code> automatically once hit.
      </P>

      <H3 id="recurring-archive">Archive</H3>
      <P>
        Archive the schedules you no longer need in front of you, such as a retainer that ended or
        one you have paused for good. In <Code>Finance → Recurring</Code>, tick the checkbox beside
        each one (shift-click ticks a range, and the header checkbox ticks every schedule in the
        current tab that can be archived), then click <Code>Archive</Code> in the bar that appears.
        A single schedule can also be archived from the <Code>More actions</Code> menu on its page.
        There is no confirmation, because nothing is lost.
      </P>
      <P>
        Only a <Code>paused</Code> or <Code>ended</Code> schedule can be archived. An active one
        would go on billing from out of sight, so its checkbox stays disabled; pause or end it
        first. An archived schedule keeps its cadence, line items, and run history, and the invoices
        it created stay in your books. It leaves the status tabs and the customer&apos;s page for
        the <Code>Archived</Code> tab, where <Code>Restore</Code> brings it back. Resuming an
        archived schedule restores it as well, so a schedule that bills is always in the list. AI
        Employees see the same split: <Code>list_recurring_invoices</Code> leaves archived schedules
        out unless asked to include them.
      </P>

      <H2 id="banking">Banking</H2>
      <P>
        Bank accounts, cards, and Stripe payouts live under <Code>Finance → Banking</Code>, with
        every transaction on them in one list. Mark which invoices a deposit paid — one, or several
        a customer settled with one transfer; Genosyn records a payment on each and matches them
        to the deposit in one step — match a transaction to a payment or entry already in the
        books, or give it a category. Card purchases are filed under their card&apos;s default
        category as they arrive. Banking is the one place a bank or card transaction&apos;s
        category changes. Banking replaced the separate Reconciliation and Card expenses pages;
        their old links open it.{" "}
        <DocLink to="/docs/banking">Banking</DocLink> covers it step by step.
      </P>

      <H2 id="vendor-credits">Vendor credits</H2>
      <P>
        The AP mirror of credit notes. When a supplier credits you — a return, a billing correction
        — open the bill and click <Code>Vendor credit</Code>. Issuing posts{" "}
        <Code>DR Vendor Credits / CR the expense account(s) / CR Tax Payable</Code>, reversing the
        bill&apos;s expense and input tax and parking the value in <Code>1300 Vendor Credits</Code>{" "}
        (an asset — the supplier owes you). Apply it to a bill to reduce what you owe (
        <Code>DR Accounts Payable / CR Vendor Credits</Code>, capped so AP can&apos;t go negative),
        or record a <Code>Refund</Code> when the supplier pays you back in cash (
        <Code>DR Bank / CR Vendor Credits</Code>). Manage them under <Code>Vendor credits</Code>;
        unapply, void and reverse work exactly like the customer side.
      </P>

      <H2 id="ledger">Accounting: the chart of accounts, journal, and reports</H2>
      <P>
        Every state change on an invoice or bill, and every bank or card transaction you explain on
        Banking, emits a journal entry into the same ledger you can write to by hand from{" "}
        <Code>Finance → Journal entries</Code>. Each entry is labeled with what posted it — an
        invoice, a payment, a bill payment, a card expense, a categorized bank transaction — and
        only an entry someone posted by hand can be deleted, until it is approved. The{" "}
        <Code>Chart of accounts</Code> is the list of categories everything is filed under, grouped
        as assets, liabilities, equity, income, and expenses, each with a line on what it holds. It
        seeds sensible defaults on first visit (1100 Bank, 1200 Accounts Receivable, 2100 Tax
        Payable, 2300 Corporate Card Payable, 4000 Sales Revenue, 4910 FX Gain, 6900 FX Loss), and
        you can rename or add accounts freely; the system accounts invoices, bills, and banking
        rely on can be renamed but not removed. From there, the <Code>Trial balance</Code> and{" "}
        <Code>Reports</Code> pages produce the standard accountant outputs (P&amp;L, balance sheet,
        cash flow) with optional period comparisons. Each report opens with a monthly graph built
        from the same ledger calculation as the table beneath it: revenue, expenses, and net income
        for P&amp;L; assets, liabilities, and equity for the balance sheet; and operating, net, and
        closing cash for cash flow. Custom periods longer than two years graph the most recent 24
        months so the axis stays readable. A money figure in a{" "}
        <DocLink to="/docs/board-letters">letter to the board</DocLink> links here, opening the
        report and dates it was read from.
      </P>

      <H2 id="proposals">Proposed entries (maker-checker)</H2>
      <P>
        A journal entry can be <Strong>staged for review</Strong> instead of posted straight away —
        the classic accounting maker-checker control, where one person drafts an entry and another
        signs it off. Compose the entry as usual under{" "}
        <Code>Finance → Journal entries → New manual entry</Code>, then click{" "}
        <Code>Propose for review</Code> rather than <Code>Post entry</Code>. Nothing hits the ledger
        yet.
      </P>
      <P>
        Staged entries collect under <Code>Finance → Proposed entries</Code>. Expand one to see its full
        debits and credits, then <Code>Apply</Code> to post it — it becomes an ordinary manual
        journal entry, tagged as one that went through review — or <Code>Reject</Code> it with an
        optional note back to the proposer. Applying re-checks everything a direct posting would
        (balance, live accounts, an open period), so a proposal staged before a period closed fails
        cleanly rather than back-dating into frozen numbers; the reason is shown on the row and the
        proposal stays pending so it can be fixed and retried.
      </P>
      <P>
        This is also the spine that AI Employees post finance work through: an AI can{" "}
        <Strong>propose</Strong> an entry, but only a person <Strong>applies</Strong> it, so no
        automation ever moves the books unattended. Every apply and reject is recorded in the audit
        log with who decided and when.
      </P>

      <H2 id="transaction-review">Entry review</H2>
      <P>
        Open <Code>Finance → Entry review</Code> to sign off on what reaches your books. Every
        posted journal entry — whether it came from an invoice, a bill, a payment, a bank or card
        transaction explained on <DocLink to="/docs/banking">Banking</DocLink>, or a manual
        posting — starts under <Strong>Needs review</Strong>, showing what posted it and the
        categories it was filed under. Open a row to see each line with its debits and credits.
        Income and expense lines have a category picker; control accounts such as Bank, Accounts
        Receivable, and Card Payable stay visible but cannot be casually recategorized. Owners and
        admins click <Code>Approve</Code> for final sign-off. Entry review is optional: nothing on
        Banking waits for it.
      </P>
      <P>
        Category corrections are append-only. Approval writes a balanced reclassification entry and
        preserves the original posting, so the Journal and audit log show both sides of the
        decision. Nothing edits a posted ledger line in place. Whatever later reverses the entry
        reverses its category change too, so nothing is left behind in either category. That
        covers voiding an invoice, a bill, or a credit, deleting a payment, and reversing a
        refund or a write-off.
      </P>
      <P>
        Before that, a reversal or an Undo on Banking took back only the entry&apos;s own lines,
        and Entry review could change a reversal or an entry already reversed. Books kept from
        then can still have a reviewed category holding money that the original category owes.
        Owners and admins can list those entries with{" "}
        <Code>GET /api/companies/:cid/ledger-review-drift</Code>: each shows its reversals, the
        changes involved, what is left on each account, and the category change that would
        clear it. Listing them posts nothing.
      </P>
      <P>
        Some entries take no category change here. They show their categories without a picker,
        with the reason, and are approved as they are:
      </P>
      <UL>
        <LI>
          <Strong>Bank and card transactions.</Strong> Their category is changed on{" "}
          <DocLink to="/docs/banking">Banking</DocLink>, which moves a transaction from wherever
          it is filed now. An entry here only shows where it was first posted. Change a card
          purchase&apos;s category in the list; undo a bank transaction and categorize it again.
          This covers card expenses and refunds, categorized bank transactions, and the
          reclassification and undo entries Banking posts for them. Card purchases whose category
          was changed here before are{" "}
          <DocLink to="/docs/banking#fix-card-categories">put right on Banking</DocLink>.
        </LI>
        <LI>
          <Strong>Reversals</Strong>, such as a void or a deleted payment. Their categories follow
          the entry they reverse.
        </LI>
        <LI>
          <Strong>Entries reversed since</Strong>, such as a voided invoice&apos;s. Nothing would
          reverse a change approved after the reversal.
        </LI>
      </UL>
      <P>
        When several entries call for the same decision, tick the checkbox on each row (or the
        header checkbox to take the whole list) and a selection bar appears with bulk{" "}
        <Code>Approve</Code>, <Code>Return</Code>, <Code>Change category</Code>, and{" "}
        <Code>Delete</Code>. <Strong>Change category</Strong> moves each entry&apos;s single
        income or expense line to one category and approves it in the same step. It skips the
        entries above, and isn&apos;t offered when only those are selected. Bulk delete only
        removes unapproved entries someone posted by hand. Every action runs per entry: rows that
        don&apos;t qualify — already approved, auto-posted, one whose category doesn&apos;t change
        here, or the wrong shape for a shared category — are skipped and reported back, never
        silently changed. Approve, Return, and Change category stay limited to owners and admins.
      </P>

      <H2 id="finance-access">Who can see and change finances</H2>
      <P>
        Finance access is a per-member setting, separate from a member&apos;s company role. Owners
        and admins always have full finance access; for everyone else, an owner or admin sets a
        level under <Code>Settings → Members</Code>:
      </P>
      <UL>
        <LI>
          <Strong>Full</Strong> — the historical behaviour and the default: post, edit, send, and
          reconcile without restriction.
        </LI>
        <LI>
          <Strong>Read-only</Strong> — view every finance page but change nothing. Pages leave out
          the controls that would change something, such as <Strong>New invoice</Strong>,{" "}
          <Strong>Issue &amp; send</Strong>, <Strong>Record payment</Strong>, <Strong>Void</Strong>,
          and a proposal&apos;s <Strong>Apply</Strong>, and show settings, templates, and a
          vendor&apos;s details for reading only. Following a saved link to a create or edit form
          shows a note in its place, with a way back. The same holds in{" "}
          <DocLink to="/docs/customers#access">Customers</DocLink>: they can open every customer but
          not create, edit, archive, or delete one. Revenue holds an account&apos;s{" "}
          <DocLink to="/docs/revenue#billing-details">billing details</DocLink> to the same bar:
          they can read them there but not change them.
        </LI>
        <LI>
          <Strong>None</Strong> — the finance section is closed to them entirely. Opening Finance
          shows them a note that they don&apos;t have access, and that an owner or admin can change
          it under <Code>Settings → Members</Code>, in place of pages that could only fail to load.
          The customer list and each customer&apos;s pages under <Code>Customers</Code> follow the
          same setting and show the same kind of note;{" "}
          <DocLink to="/docs/customers#access">Contracts and Revenue → Accounts</DocLink> stay open
          to them, though Revenue leaves out each account&apos;s{" "}
          <DocLink to="/docs/revenue#billing-details">billing details</DocLink>.
        </LI>
      </UL>
      <P>
        Existing members are <Strong>Full</Strong> after the upgrade, so nothing changes until an
        owner dials someone down. The check is enforced on the server for every finance route — a
        read-only member is blocked from mutations even if they reach the API directly — and each
        change to a member&apos;s level is written to the audit log.
      </P>

      <H2 id="ai-access">Give AI Employees finance access</H2>
      <P>
        By default an AI Employee cannot touch Finance at all. Open <Code>Finance → AI access</Code>{" "}
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
          create estimate drafts; create and manage recurring invoice schedules; create, issue,
          email, and void invoices; create and update customers; and record payments to mark an
          invoice paid. Estimate drafts do not affect the ledger and remain unissued for a Member to
          review; an authorized employee can attach a clearly marked draft quotation to email.
          Issuing an invoice mints its number and posts it to the ledger; sending emails it to the
          customer on file.
        </LI>
        <LI>
          <Strong>Full accounting</Strong> — everything in Invoicing, plus staging ledger
          re-categorizations for a human to approve (below). Final approval always stays with a
          human.
        </LI>
      </UL>
      <P>
        Access is per employee and takes effect immediately — grant it, change the level, or revoke
        it from <Code>Finance → AI access</Code>. Every write an AI Employee makes lands in the
        audit log (marked as an AI actor) and on the employee&apos;s journal, exactly like the human
        finance routes. Members still reach Finance through the app as usual; grants govern the AI
        surface only. Any level also lets the employee&apos;s Revenue tools return an account&apos;s{" "}
        <DocLink to="/docs/revenue#billing-details">billing details</DocLink>; changing them through
        those tools takes Invoicing or Full accounting.
      </P>
      <P>
        With Invoicing access, an AI Employee can call <Code>create_estimate</Code> with a customer
        slug and priced line items. Genosyn creates the same editable draft shown under{" "}
        <Code>Finance → Estimates</Code>, using the customer&apos;s currency and a thirty-day
        validity window by default. Creating the estimate assigns no number, changes no ledger
        balance, and sends no email. When asked to issue the quotation, the employee can use{" "}
        <Code>issue_estimate</Code>. This performs the same action as marking it Sent in Finance: it
        assigns a permanent number and slug and removes <Code>DRAFT</Code> from future PDFs. It
        sends no email and has no ledger effect. Until issued, the PDF stays marked{" "}
        <Code>DRAFT</Code>, even if the employee is authorized to send that preliminary quotation.
      </P>
      <P>
        To email the quotation directly to the customer on file, the employee can use{" "}
        <Code>send_estimate</Code>, which issues a draft if needed and uses the company&apos;s
        transactional email transport. Sending must be authorized by the employee&apos;s
        instructions and delivery settings; work restricted to preparing drafts cannot send. To
        reply on an existing email thread instead, issue the estimate first, then attach its
        returned <Code>estimate.slug</Code> using <Code>estimateSlug</Code> on the Email tools.
        Issuing replaces the draft slug, so subsequent reads and attachments must use the new one.
        Replace an old draft PDF attachment before sending: an email draft holds a snapshot that
        does not update when the estimate changes.
      </P>

      <P>
        Before preparing a quotation, the employee can find prior estimates for the Customer with
        <Code> list_estimates</Code>, inspect their line items and notes with{" "}
        <Code>get_estimate</Code>, and read approved prices from <Code>list_finance_products</Code>.
        Lists return a bounded page and the next offset. The product catalogue includes prices in
        their original currency and available default tax rates. Archived products, and estimates a
        Member <a href="#estimates-archive">archived</a>, are hidden unless the employee passes{" "}
        <Code>includeArchived</Code>. Missing pricing or unavailable tax defaults need
        clarification, never an invented amount.
      </P>

      <H3 id="ai-finance-tools">Finance tools</H3>
      <P>
        Granted employees use granular built-in Finance tools, reached through{" "}
        <Code>find_tools</Code> and <Code>call_tool</Code>. The read tools (
        <Code>list_subsidiaries</Code>, <Code>list_estimates</Code>, <Code>get_estimate</Code>,{" "}
        <Code>list_finance_products</Code>, <Code>list_invoices</Code>, <Code>get_invoice</Code>,{" "}
        <Code>list_customers</Code>, <Code>get_customer</Code>, <Code>list_recurring_invoices</Code>
        , <Code>get_recurring_invoice</Code>, plus the accounts / transactions / report tools) need{" "}
        <Strong>Read</Strong>. <Code>create_estimate</Code>, <Code>issue_estimate</Code>,{" "}
        <Code>send_estimate</Code>, <Code>create_recurring_invoice</Code>,{" "}
        <Code>update_recurring_invoice</Code>, and the invoice lifecycle (
        <Code>create_invoice</Code>, <Code>send_invoice</Code>, <Code>record_payment</Code>,{" "}
        <Code>void_invoice</Code>, <Code>create_customer</Code>, and <Code>update_customer</Code>)
        need <Strong>Invoicing</Strong>. Amounts are integer minor units (cents), so{" "}
        <Code>5000</Code> is $50.00. Without a Finance grant, calls are refused with a clear access
        error and the tools are deprioritized in discovery. Invoices and recurring invoices a Member{" "}
        <a href="#invoices-archive">archived</a> are left out of <Code>list_invoices</Code> and{" "}
        <Code>list_recurring_invoices</Code> unless the employee passes{" "}
        <Code>includeArchived</Code>; reports and balances always count archived invoices.
      </P>
      <P>
        When an AI Employee sends an invoice, any <Code>To</Code> / <Code>Cc</Code> it supplies is
        restricted to the customer&apos;s own email domain or a finance mailbox you saved under{" "}
        <Code>Finance → Settings → Always Cc</Code> — an AI can&apos;t mail company documents to an
        arbitrary outside address, even if a malicious invoice memo or bank description tries to
        talk it into doing so. A person sending from the invoice page is unaffected and can still
        address anyone.
      </P>

      <H3 id="ai-invoice-email">Emailing an invoice or quotation PDF</H3>
      <P>
        An employee that also has an <DocLink to="/docs/email">Email</DocLink> grant can attach an
        invoice&apos;s PDF straight to a message — no need to dig the file out of a past email. The{" "}
        <Code>create_mail_draft</Code> and <Code>send_mail</Code> tools (and the Gmail
        integration&apos;s <Code>gmail_create_draft</Code> / <Code>gmail_send_message</Code>) take
        an <Code>attachments</Code> list; name an invoice by <Code>invoiceSlug</Code> or a quotation
        by <Code>estimateSlug</Code> and Genosyn renders the PDF on the fly and attaches it. So a
        routine can reply on the original billing thread — preserving the recipient and CCs — with
        the invoice attached. Rendering the PDF needs at least <Strong>Read</Strong> finance access;
        attaching a draft estimate needs
        <Strong> Invoicing</Strong>. Sending also needs a mailbox <Strong>Send</Strong> Grant and
        authorization in the employee&apos;s instructions and delivery settings. With a
        <Strong> Draft</Strong> Grant, the employee prepares the email for Member review. Attaching
        an estimate never issues it, assigns a number, marks it sent in Finance, or accepts it. A
        draft email contains a PDF snapshot: if you change the estimate, ask the employee to refresh
        the attachment before sending.
      </P>

      <H3 id="ai-transaction-review">AI transaction review</H3>
      <P>
        At the <Strong>Full accounting</Strong> level an employee can also inspect posted
        transactions and semi-approve one with a concise review note and optional category
        proposals. The proposal does not change the ledger. It moves the transaction to{" "}
        <Strong>AI reviewed</Strong> and notifies company owners/admins, who accept the proposal,
        change it, or return the transaction for another look. AI Employees cannot issue final
        approval. An entry whose category doesn&apos;t change in Entry review takes no category
        proposal: a bank or card transaction, whose category is changed on Banking, a reversal,
        or an entry reversed since. The employee reviews it as it is and names the category it
        would use in its note.
      </P>
    </>
  );
}
